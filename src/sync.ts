import {
	Array as Arr,
	Context,
	Effect,
	identity,
	Layer,
	Option,
	Result,
	Schema,
	Semaphore,
	SynchronizedRef,
} from "effect";
import type { GraphRefused, GraphUnreadable } from "./errors.ts";
import {
	Changed,
	type DeltaPage,
	type Message,
	type Removed,
} from "./graph/api.ts";
import { Graph, type GraphError, isNotFound } from "./graph/graph.ts";
import { Store } from "./store.ts";

/**
 * Graph serves at most four concurrent requests per app and mailbox for Outlook resources
 * (https://learn.microsoft.com/graph/throttling-limits#outlook-service-limits). A pass reads this many folders at once,
 * and a check against Graph makes this many requests at once, which leaves a request for the mx mcp an agent runs.
 */
const folderConcurrency = 3;

/**
 * A folder or a message that a pass or a check skipped because Graph refused a request about it, as for a folder deleted
 * after the folder listing named it, or answered a page of the folder that mx cannot read. The next pass or check tries
 * it again, and the next listing drops a deleted folder.
 */
export interface Skipped {
	readonly error: GraphRefused | GraphUnreadable;
	/** What it skipped, as the user reads it: `folder Archive` or `a message`. */
	readonly item: string;
}

/** The line mx sync records for what a pass or a check skipped: the first, and how many more. */
export const skippedLine = ([
	first,
	...others
]: Arr.NonEmptyReadonlyArray<Skipped>) =>
	`Skipped ${first.item}: ${first.error.message}${others.length === 0 ? "" : ` (and ${others.length} more)`}`;

/** What one pass changed in the store, and what it skipped. */
export interface Pass {
	readonly folders: number;
	readonly removed: number;
	readonly saved: number;
	readonly skipped: readonly Skipped[];
}

export const summary = ({ folders, removed, saved }: Pass) =>
	`Synced ${folders} folders: ${saved} messages saved, ${removed} removed.`;

/** What a check of the store against Graph repaired, and what it skipped. */
export interface Reconciled {
	/** Messages Graph holds that the store lacked. */
	readonly added: number;
	readonly folders: number;
	/** Messages the store filed in another folder than Graph. */
	readonly refiled: number;
	/** Messages the store held that Graph no longer has. */
	readonly removed: number;
	readonly skipped: readonly Skipped[];
}

export const reconcileSummary = ({
	added,
	folders,
	refiled,
	removed,
}: Reconciled) =>
	`Reconciled ${folders} folders: ${added} added, ${refiled} refiled, ${removed} removed.`;

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

const isRemoved = (entry: Entry): entry is typeof Removed.Type =>
	"@removed" in entry;

const isChanged = Schema.is(Changed);

const noProgress = () => Effect.void;

/** `work`, or `item` skipped when Graph refuses it or answers a page mx cannot read; every other failure still fails. */
const orSkipped = <A>(
	item: string,
	work: Effect.Effect<A, GraphError | GraphUnreadable>
): Effect.Effect<
	Result.Result<A, Skipped>,
	Exclude<GraphError, GraphRefused>
> =>
	work.pipe(
		Effect.map(Result.succeed),
		Effect.catchTag(["GraphRefused", "GraphUnreadable"], (error) =>
			Effect.succeed(Result.fail({ error, item }))
		)
	);

type Repair = "added" | "refiled" | "removed" | "unchanged";

/** What locating a message repaired, from the folder the store filed it in before and Graph's copy now. */
const repairOf = (
	before: string | undefined,
	now: Option.Option<Message>
): Repair => {
	if (Option.isNone(now)) {
		return before === undefined ? "unchanged" : "removed";
	}
	if (before === undefined) {
		return "added";
	}
	return before === now.value.parentFolderId ? "unchanged" : "refiled";
};

/**
 * Brings the store up to date with the mailbox: lists every mail folder, then runs each folder's Graph delta from the
 * link the last pass saved, a few folders at once. A folder without a link, or whose link Graph no longer knows (410),
 * starts over, and the messages that round does not return leave the store. A folder's link is saved once its round
 * ends, so a pass that stops resumes each finished folder from its link. Passes run one at a time, so two never read
 * the same delta link. A page never refiles a message the store holds in another folder: Graph may have read the page
 * before a move that another folder's page brought in, so a lookup of the message by its id decides where it goes. Only
 * a lookup moves a stored message to another folder, here and in mx mcp, and the store takes lookups in the order they
 * began. A page's entry with only the properties that changed is looked up too, so the store holds the whole message as
 * Graph holds it.
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
		 * Checks the store against Graph and repairs what the deltas missed. It lists every mail folder, saving the list as a
		 * pass does, and the ids of every folder's messages; each message whose folder in Graph and in the store differ is
		 * located. It never runs at the same time as a pass, so no delta round changes a folder while it reads it.
		 */
		readonly reconcile: Effect.Effect<Reconciled, GraphError>;
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

			/**
			 * One delta round for the folder, every page, from its saved link or from the start; `fetched` hears each page. A
			 * message whose lookup Graph refuses is skipped, and so is the folder when Graph refuses its delta or answers a
			 * page mx cannot read; its link stays where the last round that ended left it.
			 */
			const round = (
				folder: { readonly id: string; readonly name: string },
				link: Option.Option<string>,
				fetched: (messages: number) => Effect.Effect<void>
			): Effect.Effect<Omit<Pass, "folders">, GraphError> =>
				Effect.gen(function* () {
					const folderId = folder.id;
					const kept: string[] = [];
					const skipped: Skipped[] = [];
					let next = link;
					let deltaLink: string | undefined;
					let saved = 0;
					let removed = 0;
					do {
						const page = yield* graph.delta(folderId, next);
						const [entries, gone] = Arr.partition(page.value, (entry) =>
							isRemoved(entry) ? Result.fail(entry) : Result.succeed(entry)
						);
						const [present, changed] = Arr.partition(entries, (entry) =>
							isChanged(entry) ? Result.fail(entry) : Result.succeed(entry)
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
						// Graph may have read this page before a move that the store already holds, and a changed entry holds only
						// some of a message, so Graph says where each one is and what it holds.
						const located = yield* Effect.forEach(
							[...filedElsewhere, ...changed],
							(entry) => orSkipped("a message", locate(entry.id))
						);
						skipped.push(...Arr.getFailures(located));
						yield* fetched(entries.length);
						kept.push(...Arr.map(entries, (entry) => entry.id));
						saved += entries.length;
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
					return { removed, saved, skipped };
				}).pipe(
					Effect.catchTag(["GraphRefused", "GraphUnreadable"], (error) =>
						error._tag === "GraphRefused" &&
						error.status === 410 &&
						Option.isSome(link)
							? round(folder, Option.none(), fetched)
							: Effect.succeed({
									removed: 0,
									saved: 0,
									skipped: [{ error, item: `folder ${folder.name}` }],
								})
					)
				);

			/** Lists every mail folder and saves the list; a folder Graph no longer has leaves with its messages. */
			const listFolders = Effect.gen(function* () {
				const folders = yield* graph.folders;
				const sentItems = yield* graph.folder("sentitems");
				yield* store.saveFolders(folders, sentItems.id);
				return folders;
			});

			const passWithProgress = Effect.fn("Sync.pass")(function* (
				report: (progress: Progress) => Effect.Effect<void>
			) {
				const folders = yield* listFolders;
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
						round(
							{ id: folder.id, name: folder.displayName },
							link,
							Option.isNone(link) ? fetched : noProgress
						),
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
					skipped: Arr.flatMap(changes, ({ skipped }) => skipped),
				};
			}, oneAtATime.withPermits(1));

			const reconcile = Effect.gen(function* () {
				const folders = yield* listFolders;
				const listings = yield* Effect.forEach(
					folders,
					(folder) =>
						Effect.map(
							orSkipped(
								`folder ${folder.displayName}`,
								graph.messageIds(folder.id)
							),
							Result.mapBoth({
								onFailure: (skipped) => ({ folderId: folder.id, skipped }),
								onSuccess: Arr.map((id) => [id, folder.id] as const),
							})
						),
					{ concurrency: folderConcurrency }
				);
				const [listed, unlisted] = Arr.partition(listings, identity);
				const inGraph = new Map(Arr.flatten(listed));
				const inStore = yield* store.placements;
				const refusedFolders = new Set(
					Arr.map(unlisted, ({ folderId }) => folderId)
				);
				// A folder Graph refused to list says nothing about the messages the store files in it.
				const inListedFolders = Arr.filter(
					[...inStore],
					([, folderId]) => !refusedFolders.has(folderId)
				);
				const differ = Arr.filter(
					[
						...new Set([
							...inGraph.keys(),
							...Arr.map(inListedFolders, ([id]) => id),
						]),
					],
					(id) => inGraph.get(id) !== inStore.get(id)
				);
				const repairs = yield* Effect.forEach(
					differ,
					(id) =>
						orSkipped(
							"a message",
							Effect.map(locate(id), (now) => repairOf(inStore.get(id), now))
						),
					{ concurrency: folderConcurrency }
				);
				const count = (wanted: Repair) =>
					Arr.filter(Arr.getSuccesses(repairs), (repair) => repair === wanted)
						.length;
				return {
					added: count("added"),
					folders: folders.length,
					refiled: count("refiled"),
					removed: count("removed"),
					skipped: [
						...Arr.map(unlisted, ({ skipped }) => skipped),
						...Arr.getFailures(repairs),
					],
				};
			}).pipe(oneAtATime.withPermits(1), Effect.withSpan("Sync.reconcile"));

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
					folder.value,
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
				reconcile,
			});
		})
	);

	static readonly layer = Sync.layerNoDeps.pipe(
		Layer.provide(Layer.mergeAll(Graph.layer, Store.layer))
	);
}
