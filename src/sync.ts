import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Result,
	Semaphore,
	SynchronizedRef,
} from "effect";
import type { DeltaPage, Message } from "./graph/api.ts";
import { Graph, type GraphError, isNotFound } from "./graph/graph.ts";
import { Store } from "./store.ts";

/**
 * Graph serves at most four concurrent requests per app and mailbox for Outlook resources
 * (https://learn.microsoft.com/graph/throttling-limits#outlook-service-limits). A pass reads this many folders at once,
 * which leaves a request for the mx mcp an agent runs.
 */
const folderConcurrency = 3;

/** What one pass changed in the store. */
export interface Pass {
	readonly folders: number;
	readonly removed: number;
	readonly saved: number;
}

export const summary = ({ folders, removed, saved }: Pass) =>
	`Synced ${folders} folders: ${saved} messages saved, ${removed} removed.`;

/** How far a pass has got through the folders it reads from the start, as on the first sync. */
export interface Progress {
	/** The messages it has read from them so far. */
	readonly fetched: number;
	/** The folders it reads from the start. */
	readonly folders: number;
	/** The messages Graph counts in those folders. */
	readonly total: number;
}

type Entry = DeltaPage["value"][number];

const isRemoved = (entry: Entry): entry is Exclude<Entry, Message> =>
	"@removed" in entry;

const noProgress = () => Effect.void;

/**
 * Brings the store up to date with the mailbox: lists every mail folder, then runs each folder's Graph delta from the
 * link the last pass saved, a few folders at once. A folder without a link, or whose link Graph no longer knows (410),
 * starts over, and the messages that round does not return leave the store. A folder's link is saved once its round
 * ends, so a pass that stops resumes each finished folder from its link. Passes run one at a time, so two never read
 * the same delta link. A page never refiles a message the store holds in another folder: Graph may have read the page
 * before a move that another folder's page brought in, so a lookup of the message by its id decides where it goes. Only
 * a lookup moves a stored message to another folder, here and in mx mcp, and the store takes lookups in the order they
 * began.
 */
export class Sync extends Context.Service<
	Sync,
	{
		readonly pass: Effect.Effect<Pass, GraphError>;
		/**
		 * `pass`, telling `report` how far it has got through the folders it reads from the start: once it has listed the
		 * folders, and after each page. It reports nothing when every folder has a link.
		 */
		readonly passWithProgress: (
			report: (progress: Progress) => Effect.Effect<void>
		) => Effect.Effect<Pass, GraphError>;
		/** Whether the store has finished a first pass: it knows the folders, and each has a link. */
		readonly finishedFirstPass: Effect.Effect<boolean>;
		/** One folder's delta round, for a change notification about it. */
		readonly folderPass: (folderId: string) => Effect.Effect<Pass, GraphError>;
		/**
		 * Asks Graph for the message by its immutable id, which a move keeps, and files it where Graph holds it. A message
		 * Graph answers 404 for leaves the store, and the answer is none. A folder the store does not know yet, as before the
		 * first sync, is added from Graph first. An answer that a later lookup's answer overtook changes nothing.
		 */
		readonly locate: (
			graphId: string
		) => Effect.Effect<Option.Option<Message>, GraphError>;
	}
>()("mx/sync") {
	static readonly layerNoDeps = Layer.effect(
		Sync,
		Effect.gen(function* () {
			const graph = yield* Graph;
			const store = yield* Store;
			const oneAtATime = yield* Semaphore.make(1);

			/** Adds the folder from Graph when the store does not know it yet. */
			const knowFolder = Effect.fnUntraced(function* (folderId: string) {
				if (yield* store.hasFolder(folderId)) {
					return;
				}
				const [folder, sentItems] = yield* Effect.all(
					[graph.folder(folderId), graph.folder("sentitems")],
					{ concurrency: 2 }
				);
				yield* store.saveFolder(folder, folder.id === sentItems.id);
			});

			const locate = Effect.fn("Sync.locate")(function* (graphId: string) {
				const lookup = yield* store.lookup(graphId);
				const current = yield* graph.message(graphId).pipe(
					Effect.asSome,
					Effect.catchIf(isNotFound, () => Effect.succeedNone)
				);
				if (Option.isSome(current)) {
					yield* knowFolder(current.value.parentFolderId);
				}
				yield* store.file(lookup, current);
				return current;
			});

			/** One delta round for the folder, every page, from its saved link or from the start; `fetched` hears each page. */
			const round = (
				folderId: string,
				link: Option.Option<string>,
				fetched: (messages: number) => Effect.Effect<void>
			): Effect.Effect<{ removed: number; saved: number }, GraphError> =>
				Effect.gen(function* () {
					const kept: string[] = [];
					let next = link;
					let deltaLink: string | undefined;
					let saved = 0;
					let removed = 0;
					do {
						const page = yield* graph.delta(folderId, next);
						const [present, gone] = Arr.partition(page.value, (entry) =>
							isRemoved(entry) ? Result.fail(entry) : Result.succeed(entry)
						);
						const filedElsewhere = yield* store.transaction(
							Effect.andThen(
								Effect.forEach(
									gone,
									(entry) => store.remove(entry.id, folderId),
									{ discard: true }
								),
								Effect.filter(present, (message) =>
									Effect.map(store.saveInPlace(message), Option.isNone)
								)
							)
						);
						// Graph may have read this page before a move that the store already holds, so Graph says where each one is.
						yield* Effect.forEach(
							filedElsewhere,
							(message) => locate(message.id),
							{ discard: true }
						);
						yield* fetched(present.length);
						kept.push(...Arr.map(present, (message) => message.id));
						saved += present.length;
						removed += gone.length;
						next = Option.fromNullishOr(page["@odata.nextLink"]);
						deltaLink = page["@odata.deltaLink"];
					} while (Option.isSome(next));
					if (deltaLink === undefined) {
						return yield* Effect.die(
							`Graph ended the delta round of folder ${folderId} without a delta link.`
						);
					}
					yield* store.transaction(
						Effect.andThen(
							Option.isNone(link)
								? store.keepOnly(folderId, kept)
								: Effect.void,
							store.setDeltaLink(folderId, deltaLink)
						)
					);
					return { removed, saved };
				}).pipe(
					Effect.catchTag("GraphRefused", (refused) =>
						refused.status === 410 && Option.isSome(link)
							? round(folderId, Option.none(), fetched)
							: Effect.fail(refused)
					)
				);

			const passWithProgress = Effect.fn("Sync.pass")(function* (
				report: (progress: Progress) => Effect.Effect<void>
			) {
				const folders = yield* graph.folders;
				const sentItems = yield* graph.folder("sentitems");
				yield* store.saveFolders(folders, sentItems.id);
				const links = new Map(
					Arr.getSomes(
						Arr.map(yield* store.folders, ({ deltaLink, id }) =>
							Option.map(deltaLink, (saved) => [id, saved] as const)
						)
					)
				);
				const rounds = Arr.map(folders, (folder) => ({
					folder,
					link: Option.fromUndefinedOr(links.get(folder.id)),
				}));
				const fresh = Arr.filter(rounds, ({ link }) => Option.isNone(link));
				const progress = yield* SynchronizedRef.make<Progress>({
					fetched: 0,
					folders: fresh.length,
					total: Arr.reduce(
						fresh,
						0,
						(total, { folder }) => total + folder.totalItemCount
					),
				});
				/** Counts a page and reports, one page at a time, so the reports arrive in order. */
				const fetched = (messages: number) =>
					SynchronizedRef.updateEffect(progress, (current) => {
						const updated = {
							...current,
							fetched: current.fetched + messages,
						};
						return Effect.as(report(updated), updated);
					});
				if (Arr.isArrayNonEmpty(fresh)) {
					yield* report(yield* SynchronizedRef.get(progress));
				}
				const changes = yield* Effect.forEach(
					rounds,
					({ folder, link }) =>
						round(folder.id, link, Option.isNone(link) ? fetched : noProgress),
					{ concurrency: folderConcurrency }
				);
				return {
					folders: folders.length,
					removed: Arr.reduce(
						changes,
						0,
						(total, { removed }) => total + removed
					),
					saved: Arr.reduce(changes, 0, (total, { saved }) => total + saved),
				};
			}, oneAtATime.withPermits(1));

			const finishedFirstPass = Effect.map(
				store.folders,
				(stored) =>
					Arr.isReadonlyArrayNonEmpty(stored) &&
					Arr.every(stored, ({ deltaLink }) => Option.isSome(deltaLink))
			);

			const folderPass = Effect.fn("Sync.folderPass")(function* (
				folderId: string
			) {
				const folder = Arr.findFirst(
					yield* store.folders,
					(stored) => stored.id === folderId
				);
				if (Option.isNone(folder)) {
					return yield* passWithProgress(noProgress);
				}
				const changed = yield* round(
					folderId,
					folder.value.deltaLink,
					noProgress
				).pipe(oneAtATime.withPermits(1));
				return { folders: 1, ...changed };
			});

			return Sync.of({
				finishedFirstPass,
				folderPass,
				locate,
				pass: passWithProgress(noProgress),
				passWithProgress,
			});
		})
	);

	static readonly layer = Sync.layerNoDeps.pipe(
		Layer.provide(Layer.mergeAll(Graph.layer, Store.layer))
	);
}
