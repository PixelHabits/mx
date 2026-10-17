import { Array as Arr, Context, Effect, Layer, Option, Result } from "effect";
import type { DeltaPage, Message } from "./graph/api.ts";
import { Graph, type GraphError } from "./graph/graph.ts";
import { Store } from "./store.ts";

/** What one pass changed in the store. */
export interface Pass {
	readonly folders: number;
	readonly removed: number;
	readonly saved: number;
}

type Entry = DeltaPage["value"][number];

const isRemoved = (entry: Entry): entry is Exclude<Entry, Message> =>
	"@removed" in entry;

/**
 * Brings the store up to date with the mailbox: lists every mail folder, then runs each folder's Graph delta from the
 * link the last pass saved. A folder without a link, or whose link Graph no longer knows (410), starts over, and the
 * messages that round does not return leave the store.
 */
export class Sync extends Context.Service<
	Sync,
	{ readonly pass: Effect.Effect<Pass, GraphError> }
>()("mx/sync") {
	static readonly layerNoDeps = Layer.effect(
		Sync,
		Effect.gen(function* () {
			const graph = yield* Graph;
			const store = yield* Store;

			/** One delta round for the folder, every page, from its saved link or from the start. */
			const round = (
				folderId: string,
				link: Option.Option<string>
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
						yield* store.transaction(
							Effect.andThen(
								Effect.forEach(
									gone,
									(entry) => store.remove(entry.id, folderId),
									{ discard: true }
								),
								Effect.forEach(present, store.save, { discard: true })
							)
						);
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
					if (Option.isNone(link)) {
						yield* store.keepOnly(folderId, kept);
					}
					yield* store.setDeltaLink(folderId, deltaLink);
					return { removed, saved };
				}).pipe(
					Effect.catchTag("GraphRefused", (refused) =>
						refused.status === 410 && Option.isSome(link)
							? round(folderId, Option.none())
							: Effect.fail(refused)
					)
				);

			const pass = Effect.gen(function* () {
				const folders = yield* graph.folders;
				const sentItems = yield* graph.folder("sentitems");
				yield* store.saveFolders(folders, sentItems.id);
				let saved = 0;
				let removed = 0;
				for (const folder of yield* store.folders) {
					const changed = yield* round(folder.id, folder.deltaLink);
					saved += changed.saved;
					removed += changed.removed;
				}
				return { folders: folders.length, removed, saved };
			}).pipe(Effect.withSpan("Sync.pass"));

			return Sync.of({ pass });
		})
	);

	static readonly layer = Sync.layerNoDeps.pipe(
		Layer.provide(Layer.mergeAll(Graph.layer, Store.layer))
	);
}
