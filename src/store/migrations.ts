import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Array as Arr, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { NewerStore } from "../errors.ts";
import { initial } from "./migrations/0001-initial.ts";

/** The table in which the store records each migration it ran, by id and name. */
const table = "effect_sql_migrations";

/**
 * The store's migrations by `<id>_<name>`, imported here so that the binary holds them. Each runs once on a store, which
 * records it, and none changes once released: a later change to the schema is a migration of its own.
 *
 * The store mirrors the mailbox, so Graph can refill all of it except `local_ids`, the `#N` id each message got, and
 * every migration keeps `local_ids`. A migration that cannot convert the stored mail in place may clear every folder's
 * `delta_link` instead, so that the next pass reads each folder from the start.
 */
export const migrations = { "0001_initial": initial };

/**
 * Runs each migration in `known` that the store has not recorded. A store that records a migration `known` lacks was
 * written by a newer mx, and is refused. All of it runs in one transaction, so a refused store stays as it was.
 */
export const migrate = Effect.fnUntraced(function* (
	known: Parameters<typeof SqliteMigrator.fromRecord>[0]
) {
	const sql = yield* SqlClient.SqlClient;
	const loader = SqliteMigrator.fromRecord(known);
	const ids = Arr.map(yield* loader, ([id]) => id);
	yield* sql
		.withTransaction(
			Effect.gen(function* () {
				yield* Effect.orDie(SqliteMigrator.run({ loader, table }));
				const unknown = yield* Effect.orDie(
					sql`SELECT migration_id FROM ${sql(table)} WHERE migration_id NOT IN ${sql.in(ids)}`
				);
				if (Arr.isReadonlyArrayNonEmpty(unknown)) {
					return yield* NewerStore.make({});
				}
			})
		)
		.pipe(Effect.catchTag("SqlError", Effect.die));
});
