import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * The tables, indexes and triggers of the store. A store that mx 0.1.0 created holds them all but records no migration,
 * so each statement keeps IF NOT EXISTS: on such a store this migration is recorded and changes nothing.
 */
export const initial = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS folders (
	id TEXT PRIMARY KEY,
	parent_id TEXT NOT NULL,
	name TEXT NOT NULL,
	path TEXT NOT NULL,
	sent INTEGER NOT NULL,
	delta_link TEXT
)`;
	// The local id each Graph id got. A row stays after its message leaves, so a message that comes back, as after a move
	// whose source folder synced first, gets its id again, and AUTOINCREMENT never gives an id to a second message.
	yield* sql`CREATE TABLE IF NOT EXISTS local_ids (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	graph_id TEXT NOT NULL UNIQUE
)`;
	// Each lookup of a message by its Graph id, in either mx process, takes the next number in asked as it begins; filed
	// is the number of the lookup whose answer the store holds. An answer to an earlier lookup than that changes nothing.
	yield* sql`CREATE TABLE IF NOT EXISTS lookups (
	graph_id TEXT PRIMARY KEY,
	asked INTEGER NOT NULL,
	filed INTEGER NOT NULL
)`;
	yield* sql`CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY REFERENCES local_ids (id),
	graph_id TEXT NOT NULL UNIQUE,
	folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	internet_message_id TEXT,
	from_name TEXT NOT NULL,
	from_address TEXT NOT NULL,
	to_list TEXT NOT NULL,
	cc_list TEXT NOT NULL,
	bcc_list TEXT NOT NULL,
	subject TEXT NOT NULL,
	received_at INTEGER,
	sent_at INTEGER,
	is_read INTEGER NOT NULL,
	is_draft INTEGER NOT NULL,
	flag TEXT NOT NULL,
	categories TEXT NOT NULL,
	importance TEXT NOT NULL,
	has_attachments INTEGER NOT NULL,
	body TEXT NOT NULL
)`;
	yield* sql`CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id)`;
	yield* sql`CREATE INDEX IF NOT EXISTS messages_folder ON messages (folder_id)`;
	// The full-text index over subject, sender and new text. The porter stemmer indexes each word by its stem, so
	// approve, approved and approval match one another.
	yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (subject, sender, body, tokenize = 'porter unicode61 remove_diacritics 2')`;
	yield* sql`CREATE TRIGGER IF NOT EXISTS messages_inserted AFTER INSERT ON messages BEGIN
	INSERT INTO search (rowid, subject, sender, body) VALUES (new.id, new.subject, new.from_name || ' ' || new.from_address, new.body);
END`;
	yield* sql`CREATE TRIGGER IF NOT EXISTS messages_deleted AFTER DELETE ON messages BEGIN
	DELETE FROM search WHERE rowid = old.id;
END`;
	yield* sql`CREATE TRIGGER IF NOT EXISTS messages_updated AFTER UPDATE ON messages BEGIN
	DELETE FROM search WHERE rowid = old.id;
	INSERT INTO search (rowid, subject, sender, body) VALUES (new.id, new.subject, new.from_name || ' ' || new.from_address, new.body);
END`;
	// What the running mx sync last wrote about itself, in one row that mx status and the read tools read.
	yield* sql`CREATE TABLE IF NOT EXISTS heartbeat (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	written_at INTEGER NOT NULL,
	last_success_at INTEGER,
	mode TEXT NOT NULL,
	version TEXT NOT NULL,
	last_error TEXT
)`;
});
