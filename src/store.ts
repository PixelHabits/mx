import { Database } from "bun:sqlite";
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect";
import type { Folder, Message, Recipient } from "./graph/api.ts";
import { Paths } from "./paths.ts";

/** Waits this long for a write lock that the other mx process holds. */
const busyTimeoutMillis = 5000;

/**
 * The full-text index over subject, sender and new text. The porter stemmer indexes each word by its stem, so approve,
 * approved and approval match one another.
 */
const searchTable =
	"fts5 (subject, sender, body, tokenize = 'porter unicode61 remove_diacritics 2')";

/** How much a match in each column of the index counts toward relevance. */
const columnWeights = { body: 1, sender: 2, subject: 10 };

/** FTS5's bm25 relevance of a row, lower for a better match; it takes the weights in column order. */
const relevance = `bm25(search, ${columnWeights.subject}, ${columnWeights.sender}, ${columnWeights.body})`;

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS folders (
	id TEXT PRIMARY KEY,
	parent_id TEXT NOT NULL,
	name TEXT NOT NULL,
	path TEXT NOT NULL,
	sent INTEGER NOT NULL,
	delta_link TEXT
);
-- The local id each Graph id got. A row stays after its message leaves, so a message that comes back, as after a move
-- whose source folder synced first, gets its id again, and AUTOINCREMENT never gives an id to a second message.
CREATE TABLE IF NOT EXISTS local_ids (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	graph_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS messages (
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
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS messages_folder ON messages (folder_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING ${searchTable};
CREATE TRIGGER IF NOT EXISTS messages_inserted AFTER INSERT ON messages BEGIN
	INSERT INTO search (rowid, subject, sender, body) VALUES (new.id, new.subject, new.from_name || ' ' || new.from_address, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_deleted AFTER DELETE ON messages BEGIN
	DELETE FROM search WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS messages_updated AFTER UPDATE ON messages BEGIN
	DELETE FROM search WHERE rowid = old.id;
	INSERT INTO search (rowid, subject, sender, body) VALUES (new.id, new.subject, new.from_name || ' ' || new.from_address, new.body);
END;
-- What the running mx sync last wrote about itself, in one row that mx status and the read tools read.
CREATE TABLE IF NOT EXISTS heartbeat (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	written_at INTEGER NOT NULL,
	last_success_at INTEGER,
	mode TEXT NOT NULL,
	version TEXT NOT NULL,
	last_error TEXT
);
`;

const Address = Schema.Struct({ address: Schema.String, name: Schema.String });
export type Address = typeof Address.Type;

const Flag = Schema.Literals([0, 1]);

/** A message row joined with its folder, as SQLite returns it. */
const Row = Schema.Struct({
	bcc_list: Schema.fromJsonString(Schema.Array(Address)),
	body: Schema.String,
	categories: Schema.fromJsonString(Schema.Array(Schema.String)),
	cc_list: Schema.fromJsonString(Schema.Array(Address)),
	conversation_id: Schema.String,
	flag: Schema.Literals(["notFlagged", "flagged", "complete"]),
	folder_path: Schema.String,
	folder_sent: Flag,
	from_address: Schema.String,
	from_name: Schema.String,
	graph_id: Schema.String,
	has_attachments: Flag,
	id: Schema.Int,
	importance: Schema.Literals(["low", "normal", "high"]),
	is_draft: Flag,
	is_read: Flag,
	received_at: Schema.NullOr(Schema.Int),
	sent_at: Schema.NullOr(Schema.Int),
	subject: Schema.String,
	to_list: Schema.fromJsonString(Schema.Array(Address)),
});

/** A message row with how many other messages its conversation holds. */
const FoundRow = Schema.Struct({ ...Row.fields, others: Schema.Int });

/** How mx sync follows the mailbox: starting up, through push notifications, or by polling while push is down. */
export const SyncMode = Schema.Literals(["starting", "push", "poll"]);
export type SyncMode = typeof SyncMode.Type;

const HeartbeatRow = Schema.Struct({
	last_error: Schema.NullOr(Schema.String),
	last_success_at: Schema.NullOr(Schema.Int),
	mode: SyncMode,
	version: Schema.String,
	written_at: Schema.Int,
});

/** What mx sync last wrote about itself, after a pass or when its mode changed. */
export interface Heartbeat {
	/** When mx sync wrote it. */
	readonly at: Temporal.Instant;
	/** The last error as a one-line message for the user; none once a pass succeeds. */
	readonly error: Option.Option<string>;
	/** When a pass last succeeded. */
	readonly lastSuccess: Option.Option<Temporal.Instant>;
	readonly mode: SyncMode;
	/** The version of the mx that runs mx sync. */
	readonly version: string;
}

const FolderRow = Schema.Struct({
	delta_link: Schema.NullOr(Schema.String),
	id: Schema.String,
	name: Schema.String,
	path: Schema.String,
	sent: Flag,
});

/** A stored message, by its short local id. */
export interface Stored {
	readonly attachments: boolean;
	readonly bcc: readonly Address[];
	readonly body: string;
	readonly categories: readonly string[];
	readonly cc: readonly Address[];
	readonly conversationId: string;
	readonly draft: boolean;
	readonly flag: "notFlagged" | "flagged" | "complete";
	readonly folder: string;
	readonly from: Option.Option<Address>;
	readonly graphId: string;
	readonly id: number;
	/** Whether the message sits in Sent Items. */
	readonly inSentItems: boolean;
	readonly read: boolean;
	/** When Graph received the message, or for a draft when it was saved. */
	readonly received: Option.Option<Temporal.Instant>;
	readonly sent: Option.Option<Temporal.Instant>;
	readonly subject: string;
	readonly to: readonly Address[];
}

/** One conversation a search found, by its best match. */
export interface Found {
	readonly message: Stored;
	/** The conversation's other messages, in every folder, whether they match or not. */
	readonly others: number;
}

export interface StoredFolder {
	readonly deltaLink: Option.Option<string>;
	readonly id: string;
	readonly name: string;
	/** The folder's display names from the top of the mailbox, joined by `/`, as in `Inbox/Projects`. */
	readonly path: string;
	readonly sent: boolean;
}

const instant = (millis: number | null) =>
	Option.map(Option.fromNullishOr(millis), (ms) =>
		Temporal.Instant.fromEpochMilliseconds(ms)
	);

const stored = (row: typeof Row.Type): Stored => ({
	attachments: row.has_attachments === 1,
	bcc: row.bcc_list,
	body: row.body,
	categories: row.categories,
	cc: row.cc_list,
	conversationId: row.conversation_id,
	draft: row.is_draft === 1,
	flag: row.flag,
	folder: row.folder_path,
	from:
		row.from_address === "" && row.from_name === ""
			? Option.none()
			: Option.some({ address: row.from_address, name: row.from_name }),
	graphId: row.graph_id,
	id: row.id,
	inSentItems: row.folder_sent === 1,
	read: row.is_read === 1,
	received: instant(row.received_at),
	sent: instant(row.sent_at),
	subject: row.subject,
	to: row.to_list,
});

const encodeAddresses = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Array(Address))
);
const encodeStrings = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Array(Schema.String))
);

const address = ({ emailAddress }: Recipient): Address => ({
	address: emailAddress.address ?? "",
	name: emailAddress.name ?? emailAddress.address ?? "",
});

const select =
	"SELECT m.*, f.path AS folder_path, f.sent AS folder_sent FROM messages m JOIN folders f ON f.id = m.folder_id";

/** When the message arrived; a draft has no received time until Graph saves it, so its sent or saved time stands in. */
const arrived = "COALESCE(m.received_at, m.sent_at)";

const whitespace = /\s+/u;

/** `LIKE` wildcards, and `!`, the escape character mx gives them. */
const likeWildcards = /[!%_]/gu;

/** A full-text query of the words in `text`, each quoted so punctuation never reads as FTS5 syntax. */
const ftsQuery = (text: string) =>
	Arr.join(
		Arr.map(
			Arr.filter(text.split(whitespace), (word) => word !== ""),
			(word) => `"${word.replaceAll('"', '""')}"`
		),
		" "
	);

/**
 * The local copy of the mailbox in SQLite: folders with their delta links, one row per message with a short integer id
 * that stays with the message through moves and never names another message, and an FTS5 index over subject, sender
 * and new text that triggers keep current.
 */
export class Store extends Context.Service<
	Store,
	{
		readonly folders: Effect.Effect<readonly StoredFolder[]>;
		readonly hasFolder: (id: string) => Effect.Effect<boolean>;
		/** Adds or renames one folder, below its parent when the store has the parent. Its delta link stays. */
		readonly saveFolder: (folder: Folder, sent: boolean) => Effect.Effect<void>;
		/** Replaces the folder list; a folder no longer listed leaves with its messages. Delta links stay. */
		readonly saveFolders: (
			folders: readonly Folder[],
			sentItemsId: string
		) => Effect.Effect<void>;
		readonly setDeltaLink: (
			folderId: string,
			link: string
		) => Effect.Effect<void>;
		/** Inserts or updates each message by its Graph id and returns its local id, the one that Graph id always gets. */
		readonly save: (message: Message) => Effect.Effect<number>;
		/** Removes the message only while it is still filed in `folderId`, since a move reports it removed there. */
		readonly remove: (graphId: string, folderId: string) => Effect.Effect<void>;
		/** Removes the folder's messages whose Graph ids `kept` does not list. */
		readonly keepOnly: (
			folderId: string,
			kept: readonly string[]
		) => Effect.Effect<void>;
		readonly transaction: <A>(run: Effect.Effect<A>) => Effect.Effect<A>;
		readonly byId: (id: number) => Effect.Effect<Option.Option<Stored>>;
		/**
		 * Up to `limit` conversations with a message that passes the filter, one per conversation: with `text`, the best
		 * match of each, best first; without it, the newest of each, newest first.
		 */
		readonly search: (filter: {
			readonly folderId: Option.Option<string>;
			readonly from: Option.Option<string>;
			readonly limit: number;
			readonly since: Option.Option<Temporal.Instant>;
			readonly text: Option.Option<string>;
		}) => Effect.Effect<readonly Found[]>;
		/** The conversation's messages in every folder, oldest first. */
		readonly conversation: (
			conversationId: string
		) => Effect.Effect<readonly Stored[]>;
		/** Every address a message in Sent Items came from, lower-cased. */
		readonly ownAddresses: Effect.Effect<ReadonlySet<string>>;
		/** Creates the full-text index anew, with the current tokenizer, from the stored rows and returns how many it holds. */
		readonly reindex: Effect.Effect<number>;
		/** The heartbeat mx sync last wrote, or none when it never ran. */
		readonly heartbeat: Effect.Effect<Option.Option<Heartbeat>>;
		/** Replaces the heartbeat. */
		readonly beat: (heartbeat: Heartbeat) => Effect.Effect<void>;
	}
>()("mx/store") {
	static readonly layer = Layer.effect(
		Store,
		Effect.gen(function* () {
			const { database } = yield* Paths;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			yield* fs.makeDirectory(path.dirname(database), {
				mode: 0o700,
				recursive: true,
			});
			const db = yield* Effect.acquireRelease(
				Effect.sync(
					() => new Database(database, { create: true, strict: true })
				),
				(opened) => Effect.sync(() => opened.close())
			);
			const [{ fts5 }] = yield* Effect.sync(() =>
				db
					.query("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5")
					.all()
			).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Tuple([Schema.Struct({ fts5: Flag })])
					)
				),
				Effect.orDie
			);
			if (fts5 === 0) {
				return yield* Effect.die(
					"This Bun's SQLite has no FTS5, which mx needs for search."
				);
			}
			yield* Effect.sync(() => {
				db.run(`PRAGMA busy_timeout = ${busyTimeoutMillis}`);
				db.run(schema);
			});

			type Params = Record<string, string | number | null>;
			/** Runs a statement and decodes its rows; a row the schema refuses is a defect in mx's own database. */
			const all = <S extends Schema.Top & { readonly DecodingServices: never }>(
				rowSchema: S,
				sql: string,
				params: Params = {}
			) =>
				Effect.sync(() => db.query(sql).all(params)).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(rowSchema))),
					Effect.orDie
				);
			const run = (sql: string, params: Params) =>
				Effect.sync(() => {
					db.query(sql).run(params);
				});
			/** Graph ids as the JSON text `json_each` reads. */
			const jsonIds = (ids: readonly string[]) =>
				encodeStrings(ids).pipe(Effect.orDie);
			const messages = (where: string, params: Params) =>
				all(Row, `${select} ${where}`, params).pipe(
					Effect.map(Arr.map(stored))
				);

			/** Runs `effect` in one SQLite transaction; every statement runs synchronously, so nothing interleaves. */
			const transaction = <A>(effect: Effect.Effect<A>) =>
				Effect.acquireUseRelease(
					Effect.sync(() => db.run("BEGIN IMMEDIATE")),
					() => effect,
					(_, exit) =>
						Effect.sync(() =>
							db.run(exit._tag === "Success" ? "COMMIT" : "ROLLBACK")
						)
				);

			const folders = all(
				FolderRow,
				"SELECT id, name, path, sent, delta_link FROM folders"
			).pipe(
				Effect.map(
					Arr.map(
						(row): StoredFolder => ({
							deltaLink: Option.fromNullishOr(row.delta_link),
							id: row.id,
							name: row.name,
							path: row.path,
							sent: row.sent === 1,
						})
					)
				)
			);

			const upsertFolder = (
				folder: Folder,
				folderPath: string,
				sent: boolean
			) =>
				run(
					`INSERT INTO folders (id, parent_id, name, path, sent) VALUES ($id, $parent, $name, $path, $sent)
					ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, path = excluded.path, sent = excluded.sent`,
					{
						id: folder.id,
						name: folder.displayName,
						parent: folder.parentFolderId,
						path: folderPath,
						sent: sent ? 1 : 0,
					}
				);

			const hasFolder = (id: string) =>
				all(
					Schema.Struct({ id: Schema.String }),
					"SELECT id FROM folders WHERE id = $id",
					{
						id,
					}
				).pipe(Effect.map(Arr.isReadonlyArrayNonEmpty));

			const saveFolder = Effect.fnUntraced(function* (
				folder: Folder,
				sent: boolean
			) {
				const parent = yield* all(
					Schema.Struct({ path: Schema.String }),
					"SELECT path FROM folders WHERE id = $id",
					{ id: folder.parentFolderId }
				);
				yield* upsertFolder(
					folder,
					Option.match(Arr.head(parent), {
						onNone: () => folder.displayName,
						onSome: (row) => `${row.path}/${folder.displayName}`,
					}),
					sent
				);
			});

			const saveFolders = Effect.fnUntraced(function* (
				listed: readonly Folder[],
				sentItemsId: string
			) {
				const byId = new Map(Arr.map(listed, (folder) => [folder.id, folder]));
				const pathOf = (folder: Folder): string => {
					const parent = byId.get(folder.parentFolderId);
					return parent === undefined
						? folder.displayName
						: `${pathOf(parent)}/${folder.displayName}`;
				};
				const ids = yield* jsonIds(Arr.map(listed, (folder) => folder.id));
				yield* transaction(
					Effect.andThen(
						Effect.forEach(
							listed,
							(folder) =>
								upsertFolder(folder, pathOf(folder), folder.id === sentItemsId),
							{ discard: true }
						),
						run(
							"DELETE FROM folders WHERE id NOT IN (SELECT value FROM json_each($ids))",
							{ ids }
						)
					)
				);
			});

			const setDeltaLink = (folderId: string, link: string) =>
				run("UPDATE folders SET delta_link = $link WHERE id = $id", {
					id: folderId,
					link,
				});

			const save = Effect.fnUntraced(function* (message: Message) {
				const from =
					message.from === undefined || message.from === null
						? { address: "", name: "" }
						: address(message.from);
				const [to, cc, bcc, categories] = yield* Effect.all([
					encodeAddresses(Arr.map(message.toRecipients, address)),
					encodeAddresses(Arr.map(message.ccRecipients, address)),
					encodeAddresses(Arr.map(message.bccRecipients, address)),
					encodeStrings(message.categories),
				]).pipe(Effect.orDie);
				yield* run(
					"INSERT INTO local_ids (graph_id) VALUES ($graphId) ON CONFLICT (graph_id) DO NOTHING",
					{ graphId: message.id }
				);
				const saved = yield* all(
					Schema.Struct({ id: Schema.Int }),
					`INSERT INTO messages (id, graph_id, folder_id, conversation_id, internet_message_id, from_name, from_address, to_list, cc_list, bcc_list, subject, received_at, sent_at, is_read, is_draft, flag, categories, importance, has_attachments, body)
					VALUES ((SELECT id FROM local_ids WHERE graph_id = $graphId), $graphId, $folderId, $conversationId, $internetMessageId, $fromName, $fromAddress, $to, $cc, $bcc, $subject, $receivedAt, $sentAt, $isRead, $isDraft, $flag, $categories, $importance, $hasAttachments, $body)
					ON CONFLICT (graph_id) DO UPDATE SET folder_id = excluded.folder_id, conversation_id = excluded.conversation_id, internet_message_id = excluded.internet_message_id, from_name = excluded.from_name, from_address = excluded.from_address, to_list = excluded.to_list, cc_list = excluded.cc_list, bcc_list = excluded.bcc_list, subject = excluded.subject, received_at = excluded.received_at, sent_at = excluded.sent_at, is_read = excluded.is_read, is_draft = excluded.is_draft, flag = excluded.flag, categories = excluded.categories, importance = excluded.importance, has_attachments = excluded.has_attachments, body = excluded.body
					RETURNING id`,
					{
						bcc,
						body: message.uniqueBody.content,
						categories,
						cc,
						conversationId: message.conversationId,
						flag: message.flag.flagStatus,
						folderId: message.parentFolderId,
						fromAddress: from.address,
						fromName: from.name,
						graphId: message.id,
						hasAttachments: message.hasAttachments ? 1 : 0,
						importance: message.importance,
						internetMessageId: message.internetMessageId ?? null,
						isDraft: message.isDraft ? 1 : 0,
						isRead: message.isRead ? 1 : 0,
						receivedAt: message.receivedDateTime?.epochMilliseconds ?? null,
						sentAt: message.sentDateTime?.epochMilliseconds ?? null,
						subject: message.subject ?? "",
						to,
					}
				);
				return Arr.reduce(saved, 0, (_, row) => row.id);
			});

			const remove = (graphId: string, folderId: string) =>
				run(
					"DELETE FROM messages WHERE graph_id = $graphId AND folder_id = $folderId",
					{ folderId, graphId }
				);

			const keepOnly = (folderId: string, kept: readonly string[]) =>
				Effect.flatMap(jsonIds(kept), (ids) =>
					run(
						"DELETE FROM messages WHERE folder_id = $folderId AND graph_id NOT IN (SELECT value FROM json_each($ids))",
						{ folderId, ids }
					)
				);

			const byId = (id: number) =>
				Effect.map(messages("WHERE m.id = $id", { id }), Arr.head);

			const search: Store["Service"]["search"] = (filter) =>
				all(
					FoundRow,
					`WITH candidates AS (${Option.match(filter.text, {
						onNone: () => "SELECT id, 0 AS rank FROM messages",
						onSome: () =>
							`SELECT rowid AS id, ${relevance} AS rank FROM search WHERE search MATCH $text`,
					})}),
					matched AS (
						SELECT m.id, m.conversation_id, c.rank, ${arrived} AS at FROM candidates c JOIN messages m ON m.id = c.id
						WHERE ($folderId IS NULL OR m.folder_id = $folderId)
						AND ($from IS NULL OR m.from_address LIKE $from ESCAPE '!' OR m.from_name LIKE $from ESCAPE '!')
						AND ($since IS NULL OR ${arrived} >= $since)
					),
					best AS (
						SELECT id, rank, at, row_number() OVER (PARTITION BY conversation_id ORDER BY rank, at DESC, id DESC) AS place
						FROM matched
					)
					SELECT m.*, f.path AS folder_path, f.sent AS folder_sent,
						(SELECT count(*) FROM messages t WHERE t.conversation_id = m.conversation_id) - 1 AS others
					FROM best b JOIN messages m ON m.id = b.id JOIN folders f ON f.id = m.folder_id
					WHERE b.place = 1
					ORDER BY b.rank, b.at DESC, b.id DESC LIMIT $limit`,
					{
						folderId: Option.getOrNull(filter.folderId),
						from: Option.getOrNull(
							Option.map(
								filter.from,
								(text) => `%${text.replaceAll(likeWildcards, (c) => `!${c}`)}%`
							)
						),
						limit: filter.limit,
						since: Option.getOrNull(
							Option.map(filter.since, (since) => since.epochMilliseconds)
						),
						text: Option.getOrNull(Option.map(filter.text, ftsQuery)),
					}
				).pipe(
					Effect.map(
						Arr.map(
							(row): Found => ({ message: stored(row), others: row.others })
						)
					)
				);

			const conversation = (conversationId: string) =>
				messages(
					"WHERE m.conversation_id = $conversationId ORDER BY COALESCE(m.sent_at, m.received_at), m.id",
					{ conversationId }
				);

			const ownAddresses = all(
				Schema.Struct({ address: Schema.String }),
				"SELECT DISTINCT lower(m.from_address) AS address FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.sent = 1 AND m.from_address != ''"
			).pipe(
				Effect.map(
					(rows): ReadonlySet<string> =>
						new Set(Arr.map(rows, (row) => row.address))
				)
			);

			const reindex = transaction(
				Effect.sync(() => {
					db.run("DROP TABLE search");
					db.run(`CREATE VIRTUAL TABLE search USING ${searchTable}`);
					db.run(
						"INSERT INTO search (rowid, subject, sender, body) SELECT id, subject, from_name || ' ' || from_address, body FROM messages"
					);
				})
			).pipe(
				Effect.andThen(
					all(
						Schema.Struct({ count: Schema.Int }),
						"SELECT count(*) AS count FROM search"
					)
				),
				Effect.map(Arr.reduce(0, (total, row) => total + row.count))
			);

			const heartbeat = all(
				HeartbeatRow,
				"SELECT written_at, last_success_at, mode, version, last_error FROM heartbeat"
			).pipe(
				Effect.map((rows) =>
					Option.map(
						Arr.head(rows),
						(row): Heartbeat => ({
							at: Temporal.Instant.fromEpochMilliseconds(row.written_at),
							error: Option.fromNullishOr(row.last_error),
							lastSuccess: instant(row.last_success_at),
							mode: row.mode,
							version: row.version,
						})
					)
				)
			);

			const beat = (written: Heartbeat) =>
				run(
					`INSERT INTO heartbeat (id, written_at, last_success_at, mode, version, last_error) VALUES (1, $at, $lastSuccess, $mode, $version, $error)
					ON CONFLICT (id) DO UPDATE SET written_at = excluded.written_at, last_success_at = excluded.last_success_at, mode = excluded.mode, version = excluded.version, last_error = excluded.last_error`,
					{
						at: written.at.epochMilliseconds,
						error: Option.getOrNull(written.error),
						lastSuccess: Option.getOrNull(
							Option.map(written.lastSuccess, (at) => at.epochMilliseconds)
						),
						mode: written.mode,
						version: written.version,
					}
				);

			return Store.of({
				beat,
				byId,
				conversation,
				folders,
				hasFolder,
				heartbeat,
				keepOnly,
				ownAddresses,
				reindex,
				remove,
				save,
				saveFolder,
				saveFolders,
				search,
				setDeltaLink,
				transaction,
			});
		})
	);
}
