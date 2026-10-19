import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Files every folder, and through its folder every message, under an account, and gives each account a status row. The
 * mail stored so far is account 1's, and its status is the heartbeat's.
 *
 * Each statement only adds: the migration runs in a transaction with foreign keys on, where rebuilding `folders` would
 * delete every message through ON DELETE CASCADE. An mx mcp of the release before keeps running against the migrated
 * store until its agent restarts, so `heartbeat` keeps every column it reads, and a folder it saves lands in account 1.
 */
export const accounts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	// How mx sync follows each account, as heartbeat holds it for the whole of mx sync.
	yield* sql`CREATE TABLE accounts (
	id INTEGER PRIMARY KEY,
	mode TEXT NOT NULL,
	last_success_at INTEGER,
	last_error TEXT
)`;
	yield* sql`INSERT INTO accounts (id, mode, last_success_at, last_error)
SELECT 1, coalesce(h.mode, 'starting'), h.last_success_at, h.last_error FROM (SELECT 1) LEFT JOIN heartbeat h`;
	// SQLite adds no REFERENCES column whose default is not NULL, so accounts (id) is not a foreign key here.
	yield* sql`ALTER TABLE folders ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1`;
	yield* sql`CREATE INDEX folders_account ON folders (account_id)`;
});
