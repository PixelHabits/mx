import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	pipe,
	Schema,
	String as Str,
} from "effect";
import { SqlClient, type SqlError, type Statement } from "effect/sql";
import type { Folder, Message, Recipient } from "./graph/api.ts";
import { outlookLink } from "./outlook.ts";
import { Paths } from "./paths.ts";
import { migrate, migrations } from "./store/migrations.ts";

/** Waits this long for a write lock that the other mx process holds. */
const busyTimeout = Duration.seconds(5);

/** How much a match in each column of the index counts toward relevance. */
const columnWeights = { body: 1, sender: 2, subject: 10 };

/** FTS5's bm25 relevance of a row, lower for a better match; it takes the weights in column order. */
const relevance = `bm25(search, ${columnWeights.subject}, ${columnWeights.sender}, ${columnWeights.body})`;

/** The link that opens a message of `messages m` in Outlook on the web. */
const messageLink = outlookLink("m.graph_id");

const Address = Schema.Struct({ address: Schema.String, name: Schema.String });
export type Address = typeof Address.Type;

const Flag = Schema.Literals([0, 1]);

/** A message row joined with its folder, as SQLite returns it. */
const Row = Schema.Struct({
	account_id: Schema.Int,
	bcc_list: Schema.fromJsonString(Schema.Array(Address)),
	body: Schema.String,
	categories: Schema.fromJsonString(Schema.Array(Schema.String)),
	cc_list: Schema.fromJsonString(Schema.Array(Address)),
	conversation_id: Schema.String,
	flag: Schema.Literals(["notFlagged", "flagged", "complete"]),
	folder_id: Schema.String,
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
	link: Schema.String,
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

const AccountSyncRow = Schema.Struct({
	id: Schema.Int,
	last_error: Schema.NullOr(Schema.String),
	last_success_at: Schema.NullOr(Schema.Int),
	mode: SyncMode,
});

/** How mx sync follows one account, as it last wrote after a pass or a check of the account, or when its mode changed. */
export interface AccountSync {
	/** The account's last error as a one-line message for the user; none once a pass of it succeeds. */
	readonly error: Option.Option<string>;
	/** When a pass of the account last succeeded. */
	readonly lastSuccess: Option.Option<Temporal.Instant>;
	readonly mode: SyncMode;
}

/**
 * What mx sync last wrote about itself, after a pass or when its mode changed. With several accounts, its mode, last
 * success and last error sum up theirs, so an mx mcp of an earlier release reads mx sync as a whole.
 */
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
	/** The account whose folder files it. */
	readonly accountId: number;
	readonly attachments: boolean;
	readonly bcc: readonly Address[];
	readonly body: string;
	readonly categories: readonly string[];
	readonly cc: readonly Address[];
	readonly conversationId: string;
	readonly draft: boolean;
	readonly flag: "notFlagged" | "flagged" | "complete";
	readonly folder: string;
	readonly folderId: string;
	readonly from: Option.Option<Address>;
	readonly graphId: string;
	readonly id: number;
	/** Whether the message sits in Sent Items. */
	readonly inSentItems: boolean;
	/** The link that opens the message in Outlook on the web. */
	readonly link: string;
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
	/** The conversation's other messages, in every folder of its account, whether they match or not. */
	readonly others: number;
}

/** A lookup of a message by its Graph id, numbered as it began. */
export interface Lookup {
	readonly graphId: string;
	readonly number: number;
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
	accountId: row.account_id,
	attachments: row.has_attachments === 1,
	bcc: row.bcc_list,
	body: row.body,
	categories: row.categories,
	cc: row.cc_list,
	conversationId: row.conversation_id,
	draft: row.is_draft === 1,
	flag: row.flag,
	folder: row.folder_path,
	folderId: row.folder_id,
	from:
		row.from_address === "" && row.from_name === ""
			? Option.none()
			: Option.some({ address: row.from_address, name: row.from_name }),
	graphId: row.graph_id,
	id: row.id,
	inSentItems: row.folder_sent === 1,
	link: row.link,
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
const encodeInts = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Array(Schema.Int))
);

const address = ({ emailAddress }: Recipient): Address => ({
	address: emailAddress.address ?? "",
	name: emailAddress.name ?? emailAddress.address ?? "",
});

const whitespace = /\s+/u;

/** `LIKE` wildcards, and `!`, the escape character mx gives them. */
const likeWildcards = /[!%_]/gu;

/** A full-text query of the words in `text`, each quoted so punctuation never reads as FTS5 syntax. */
const ftsQuery = (text: string) =>
	Arr.join(
		Arr.map(
			Arr.filter(pipe(text, Str.split(whitespace)), (word) => word !== ""),
			(word) => `"${pipe(word, Str.replaceAll('"', '""'))}"`
		),
		" "
	);

/** Runs a statement and decodes its rows; a failed statement or a row the schema refuses is a defect in mx's own database. */
const all = <S extends Schema.Top & { readonly DecodingServices: never }>(
	rowSchema: S,
	statement: Effect.Effect<readonly unknown[], SqlError.SqlError>
) =>
	statement.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(rowSchema))),
		Effect.orDie
	);

/** Runs a statement for what it changes; a failed statement is a defect in mx's own database. */
const run = (statement: Effect.Effect<unknown, SqlError.SqlError>) =>
	Effect.orDie(Effect.asVoid(statement));

/** The connection to the store, in the data folder, which it creates. */
const connection = Layer.unwrap(
	Effect.gen(function* () {
		const { database } = yield* Paths;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		yield* fs.makeDirectory(path.dirname(database), {
			mode: 0o700,
			recursive: true,
		});
		return Layer.orDie(SqliteClient.layer({ busyTimeout, filename: database }));
	})
);

/**
 * The local copy of the mailbox in SQLite: folders with their delta links, each filed under the account whose mailbox
 * holds it, one row per message with a short integer id that stays with the message through moves and never names
 * another message, and an FTS5 index over subject, sender and new text that triggers keep current. A message is in its
 * folder's account.
 */
export class Store extends Context.Service<
	Store,
	{
		/** The account's folders. */
		readonly folders: (
			accountId: number
		) => Effect.Effect<readonly StoredFolder[]>;
		readonly hasFolder: (id: string) => Effect.Effect<boolean>;
		/**
		 * Adds one folder of the account, or renames or moves it, below its parent when the store has the parent, and the
		 * folders inside it with it. Its delta link stays. Answers the path it saved.
		 */
		readonly saveFolder: (
			accountId: number,
			folder: Folder,
			sent: boolean
		) => Effect.Effect<string>;
		/**
		 * Replaces the account's folder list: a folder of the account no longer listed leaves with its messages, and
		 * other accounts' folders stay. Delta links stay.
		 */
		readonly saveFolders: (
			accountId: number,
			folders: readonly Folder[],
			sentItemsId: string
		) => Effect.Effect<void>;
		readonly setDeltaLink: (
			folderId: string,
			link: string
		) => Effect.Effect<void>;
		/**
		 * Inserts or updates the message by its Graph id, filed where `message` says, unless the store files it in another
		 * folder: a delta page can arrive after a move that a newer page of the other folder already stored, so it may not
		 * refile the message. Answers its local id, the one that Graph id always gets, or none when it saved nothing.
		 */
		readonly saveInPlace: (
			message: Message
		) => Effect.Effect<Option.Option<number>>;
		/** Removes the message only while it is still filed in `folderId`, since a move reports it removed there. */
		readonly remove: (graphId: string, folderId: string) => Effect.Effect<void>;
		/**
		 * Numbers a lookup of the message as it begins. Both mx processes number lookups in this one store, so `file` takes
		 * their answers in the order the lookups began.
		 */
		readonly lookup: (graphId: string) => Effect.Effect<Lookup>;
		/**
		 * Files Graph's answer to `lookup`: the message, saved where it names, or none for a message Graph no longer holds,
		 * which leaves the store. An answer to a lookup that began before the one whose answer the store holds changes
		 * nothing, so a reading older than the row never moves it.
		 */
		readonly file: (
			lookup: Lookup,
			answer: Option.Option<Message>
		) => Effect.Effect<void>;
		/** The folder id each stored message of the account is filed in, by its Graph id. */
		readonly placements: (
			accountId: number
		) => Effect.Effect<ReadonlyMap<string, string>>;
		/** Removes the folder's messages whose Graph ids `kept` does not list. */
		readonly keepOnly: (
			folderId: string,
			kept: readonly string[]
		) => Effect.Effect<void>;
		/**
		 * Runs `run` in one SQLite transaction. Fibers share one connection, and the transaction holds it until it ends, so
		 * another fiber's statements wait instead of joining it.
		 */
		readonly transaction: <A>(run: Effect.Effect<A>) => Effect.Effect<A>;
		readonly byId: (id: number) => Effect.Effect<Option.Option<Stored>>;
		readonly byGraphId: (
			graphId: string
		) => Effect.Effect<Option.Option<Stored>>;
		/**
		 * Up to `limit` conversations of the accounts with a message that passes the filter, one per conversation of an
		 * account: with `text`, the best match of each, best first; without it, the newest of each, newest first.
		 */
		readonly search: (filter: {
			readonly accountIds: readonly number[];
			readonly folderIds: Option.Option<readonly string[]>;
			readonly from: Option.Option<string>;
			readonly limit: number;
			readonly since: Option.Option<Temporal.Instant>;
			readonly text: Option.Option<string>;
		}) => Effect.Effect<readonly Found[]>;
		/** The conversation's messages in every folder of the account, oldest first. */
		readonly conversation: (
			accountId: number,
			conversationId: string
		) => Effect.Effect<readonly Stored[]>;
		/** Every address a message in Sent Items came from, lower-cased. */
		readonly ownAddresses: Effect.Effect<ReadonlySet<string>>;
		/** Rebuilds the full-text index from the stored rows and returns how many it holds. */
		readonly reindex: Effect.Effect<number>;
		/** The heartbeat mx sync last wrote, or none when it never ran. */
		readonly heartbeat: Effect.Effect<Option.Option<Heartbeat>>;
		/** Replaces the heartbeat. */
		readonly beat: (heartbeat: Heartbeat) => Effect.Effect<void>;
		/** How mx sync last followed each account it wrote about, by account id. */
		readonly accountSyncs: Effect.Effect<ReadonlyMap<number, AccountSync>>;
		/** Replaces how mx sync follows the account. */
		readonly saveAccountSync: (
			accountId: number,
			sync: AccountSync
		) => Effect.Effect<void>;
		/** Removes the account's folders with their mail, and how mx sync follows it. */
		readonly removeAccount: (accountId: number) => Effect.Effect<void>;
		/** Removes the folders with their mail, and how mx sync follows them, of every account but `kept`. */
		readonly keepAccounts: (kept: readonly number[]) => Effect.Effect<void>;
	}
>()("mx/store") {
	static readonly layer = Layer.effect(
		Store,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const [{ fts5 }] =
				yield* sql`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5`.pipe(
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
			yield* run(sql`PRAGMA foreign_keys = ON`);
			yield* migrate(migrations);

			const select = sql`SELECT m.*, f.account_id, f.path AS folder_path, f.sent AS folder_sent, ${sql.literal(messageLink)} AS link FROM messages m JOIN folders f ON f.id = m.folder_id`;
			/** When the message arrived; a draft has no received time until Graph saves it, so its sent or saved time stands in. */
			const arrived = sql`COALESCE(m.received_at, m.sent_at)`;

			/** Graph ids as the JSON text `json_each` reads. */
			const jsonIds = (ids: readonly string[]) =>
				encodeStrings(ids).pipe(Effect.orDie);
			const messages = (where: Statement.Fragment) =>
				all(Row, sql`${select} ${where}`).pipe(Effect.map(Arr.map(stored)));

			const transaction = <A>(effect: Effect.Effect<A>) =>
				Effect.orDie(sql.withTransaction(effect));

			const folders = (accountId: number) =>
				all(
					FolderRow,
					sql`SELECT id, name, path, sent, delta_link FROM folders WHERE account_id = ${accountId}`
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
				accountId: number,
				folder: Folder,
				folderPath: string,
				sent: boolean
			) =>
				run(
					sql`INSERT INTO folders (id, account_id, parent_id, name, path, sent) VALUES (${folder.id}, ${accountId}, ${folder.parentFolderId}, ${folder.displayName}, ${folderPath}, ${sent ? 1 : 0})
					ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, path = excluded.path, sent = excluded.sent`
				);

			const hasFolder = (id: string) =>
				all(
					Schema.Struct({ id: Schema.String }),
					sql`SELECT id FROM folders WHERE id = ${id}`
				).pipe(Effect.map(Arr.isReadonlyArrayNonEmpty));

			const storedPath = (id: string) =>
				Effect.map(
					all(
						Schema.Struct({ path: Schema.String }),
						sql`SELECT path FROM folders WHERE id = ${id}`
					),
					(rows) => Option.map(Arr.head(rows), ({ path }) => path)
				);

			const saveFolder = (accountId: number, folder: Folder, sent: boolean) =>
				transaction(
					Effect.gen(function* () {
						const before = yield* storedPath(folder.id);
						const saved = Option.match(
							yield* storedPath(folder.parentFolderId),
							{
								onNone: () => folder.displayName,
								onSome: (parent) => `${parent}/${folder.displayName}`,
							}
						);
						yield* upsertFolder(accountId, folder, saved, sent);
						if (Option.isSome(before)) {
							yield* run(
								sql`WITH RECURSIVE inside (id) AS (
									SELECT id FROM folders WHERE parent_id = ${folder.id}
									UNION SELECT f.id FROM folders f JOIN inside i ON f.parent_id = i.id
								)
								UPDATE folders SET path = ${saved} || substr(path, length(${before.value}) + 1) WHERE id IN (SELECT id FROM inside)`
							);
						}
						return saved;
					})
				);

			const saveFolders = Effect.fnUntraced(function* (
				accountId: number,
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
								upsertFolder(
									accountId,
									folder,
									pathOf(folder),
									folder.id === sentItemsId
								),
							{ discard: true }
						),
						run(
							sql`DELETE FROM folders WHERE account_id = ${accountId} AND id NOT IN (SELECT value FROM json_each(${ids}))`
						)
					)
				);
			});

			const setDeltaLink = (folderId: string, link: string) =>
				run(
					sql`UPDATE folders SET delta_link = ${link} WHERE id = ${folderId}`
				);

			/** Inserts or updates the message; an update with `inPlace` happens only while the row is filed where `message` says. */
			const upsert = Effect.fnUntraced(function* (
				message: Message,
				inPlace: boolean
			) {
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
					sql`INSERT INTO local_ids (graph_id) VALUES (${message.id}) ON CONFLICT (graph_id) DO NOTHING`
				);
				const saved = yield* all(
					Schema.Struct({ id: Schema.Int }),
					sql`INSERT INTO messages (id, graph_id, folder_id, conversation_id, internet_message_id, from_name, from_address, to_list, cc_list, bcc_list, subject, received_at, sent_at, is_read, is_draft, flag, categories, importance, has_attachments, body)
					VALUES ((SELECT id FROM local_ids WHERE graph_id = ${message.id}), ${message.id}, ${message.parentFolderId}, ${message.conversationId}, ${message.internetMessageId ?? null}, ${from.name}, ${from.address}, ${to}, ${cc}, ${bcc}, ${message.subject ?? ""}, ${message.receivedDateTime?.epochMilliseconds ?? null}, ${message.sentDateTime?.epochMilliseconds ?? null}, ${message.isRead ? 1 : 0}, ${message.isDraft ? 1 : 0}, ${message.flag.flagStatus}, ${categories}, ${message.importance}, ${message.hasAttachments ? 1 : 0}, ${message.uniqueBody.content})
					ON CONFLICT (graph_id) DO UPDATE SET folder_id = excluded.folder_id, conversation_id = excluded.conversation_id, internet_message_id = excluded.internet_message_id, from_name = excluded.from_name, from_address = excluded.from_address, to_list = excluded.to_list, cc_list = excluded.cc_list, bcc_list = excluded.bcc_list, subject = excluded.subject, received_at = excluded.received_at, sent_at = excluded.sent_at, is_read = excluded.is_read, is_draft = excluded.is_draft, flag = excluded.flag, categories = excluded.categories, importance = excluded.importance, has_attachments = excluded.has_attachments, body = excluded.body
					${inPlace ? sql`WHERE messages.folder_id = excluded.folder_id` : sql``}
					RETURNING id`
				);
				return Option.map(Arr.head(saved), (row) => row.id);
			});

			const saveInPlace = (message: Message) => upsert(message, true);

			const remove = (graphId: string, folderId: string) =>
				run(
					sql`DELETE FROM messages WHERE graph_id = ${graphId} AND folder_id = ${folderId}`
				);

			const lookup = (graphId: string) =>
				all(
					Schema.Struct({ asked: Schema.Int }),
					sql`INSERT INTO lookups (graph_id, asked, filed) VALUES (${graphId}, 1, 0)
					ON CONFLICT (graph_id) DO UPDATE SET asked = asked + 1 RETURNING asked`
				).pipe(
					Effect.flatMap(
						Arr.match({
							onEmpty: () =>
								Effect.die(`SQLite numbered no lookup of message ${graphId}.`),
							onNonEmpty: ([{ asked }]) =>
								Effect.succeed({ graphId, number: asked }),
						})
					)
				);

			const file = (
				{ graphId, number }: Lookup,
				answer: Option.Option<Message>
			) =>
				transaction(
					Effect.gen(function* () {
						const newest = yield* all(
							Schema.Struct({ filed: Schema.Int }),
							sql`UPDATE lookups SET filed = ${number} WHERE graph_id = ${graphId} AND filed < ${number} RETURNING filed`
						);
						if (Arr.isReadonlyArrayEmpty(newest)) {
							return;
						}
						yield* Option.match(answer, {
							onNone: () =>
								run(sql`DELETE FROM messages WHERE graph_id = ${graphId}`),
							onSome: (message) => upsert(message, false),
						});
					})
				);

			const placements = (accountId: number) =>
				all(
					Schema.Struct({ folder_id: Schema.String, graph_id: Schema.String }),
					sql`SELECT m.graph_id, m.folder_id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.account_id = ${accountId}`
				).pipe(
					Effect.map(
						(rows): ReadonlyMap<string, string> =>
							new Map(Arr.map(rows, (row) => [row.graph_id, row.folder_id]))
					)
				);

			const keepOnly = (folderId: string, kept: readonly string[]) =>
				Effect.flatMap(jsonIds(kept), (ids) =>
					run(
						sql`DELETE FROM messages WHERE folder_id = ${folderId} AND graph_id NOT IN (SELECT value FROM json_each(${ids}))`
					)
				);

			const byId = (id: number) =>
				Effect.map(messages(sql`WHERE m.id = ${id}`), Arr.head);

			const byGraphId = (graphId: string) =>
				Effect.map(messages(sql`WHERE m.graph_id = ${graphId}`), Arr.head);

			const search: Store["Service"]["search"] = (filter) =>
				Effect.gen(function* () {
					const accounts = yield* encodeInts(filter.accountIds).pipe(
						Effect.orDie
					);
					const inFolders = Option.getOrNull(
						yield* Effect.transposeOption(Option.map(filter.folderIds, jsonIds))
					);
					const from = Option.getOrNull(
						Option.map(
							filter.from,
							(text) => `%${pipe(text, Str.replaceAll(likeWildcards, "!$&"))}%`
						)
					);
					const since = Option.getOrNull(
						Option.map(filter.since, (at) => at.epochMilliseconds)
					);
					return yield* all(
						FoundRow,
						sql`WITH candidates AS (${Option.match(filter.text, {
							onNone: () => sql`SELECT id, 0 AS rank FROM messages`,
							onSome: (text) =>
								sql`SELECT rowid AS id, ${sql.literal(relevance)} AS rank FROM search WHERE search MATCH ${ftsQuery(text)}`,
						})}),
					matched AS (
						SELECT m.id, f.account_id, m.conversation_id, c.rank, ${arrived} AS at FROM candidates c JOIN messages m ON m.id = c.id JOIN folders f ON f.id = m.folder_id
						WHERE f.account_id IN (SELECT value FROM json_each(${accounts}))
						AND (${inFolders} IS NULL OR m.folder_id IN (SELECT value FROM json_each(${inFolders})))
						AND (${from} IS NULL OR m.from_address LIKE ${from} ESCAPE '!' OR m.from_name LIKE ${from} ESCAPE '!')
						AND (${since} IS NULL OR ${arrived} >= ${since})
					),
					best AS (
						SELECT id, rank, at, row_number() OVER (PARTITION BY account_id, conversation_id ORDER BY rank, at DESC, id DESC) AS place
						FROM matched
					)
					SELECT m.*, f.account_id, f.path AS folder_path, f.sent AS folder_sent, ${sql.literal(messageLink)} AS link,
						(SELECT count(*) FROM messages t JOIN folders tf ON tf.id = t.folder_id WHERE t.conversation_id = m.conversation_id AND tf.account_id = f.account_id) - 1 AS others
					FROM best b JOIN messages m ON m.id = b.id JOIN folders f ON f.id = m.folder_id
					WHERE b.place = 1
					ORDER BY b.rank, b.at DESC, b.id DESC LIMIT ${filter.limit}`
					).pipe(
						Effect.map(
							Arr.map(
								(row): Found => ({ message: stored(row), others: row.others })
							)
						)
					);
				});

			const conversation = (accountId: number, conversationId: string) =>
				messages(
					sql`WHERE f.account_id = ${accountId} AND m.conversation_id = ${conversationId} ORDER BY COALESCE(m.sent_at, m.received_at), m.id`
				);

			const ownAddresses = all(
				Schema.Struct({ address: Schema.String }),
				sql`SELECT DISTINCT lower(m.from_address) AS address FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.sent = 1 AND m.from_address != ''`
			).pipe(
				Effect.map(
					(rows): ReadonlySet<string> =>
						new Set(Arr.map(rows, (row) => row.address))
				)
			);

			const reindex = transaction(
				Effect.andThen(
					run(sql`DELETE FROM search`),
					run(
						sql`INSERT INTO search (rowid, subject, sender, body) SELECT id, subject, from_name || ' ' || from_address, body FROM messages`
					)
				)
			).pipe(
				Effect.andThen(
					all(
						Schema.Struct({ count: Schema.Int }),
						sql`SELECT count(*) AS count FROM search`
					)
				),
				Effect.map(Arr.reduce(0, (total, row) => total + row.count))
			);

			const heartbeat = all(
				HeartbeatRow,
				sql`SELECT written_at, last_success_at, mode, version, last_error FROM heartbeat`
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
					sql`INSERT INTO heartbeat (id, written_at, last_success_at, mode, version, last_error) VALUES (1, ${written.at.epochMilliseconds}, ${Option.getOrNull(Option.map(written.lastSuccess, (at) => at.epochMilliseconds))}, ${written.mode}, ${written.version}, ${Option.getOrNull(written.error)})
					ON CONFLICT (id) DO UPDATE SET written_at = excluded.written_at, last_success_at = excluded.last_success_at, mode = excluded.mode, version = excluded.version, last_error = excluded.last_error`
				);

			const accountSyncs = all(
				AccountSyncRow,
				sql`SELECT id, mode, last_success_at, last_error FROM accounts`
			).pipe(
				Effect.map(
					(rows): ReadonlyMap<number, AccountSync> =>
						new Map(
							Arr.map(rows, (row) => [
								row.id,
								{
									error: Option.fromNullishOr(row.last_error),
									lastSuccess: instant(row.last_success_at),
									mode: row.mode,
								},
							])
						)
				)
			);

			const saveAccountSync = (accountId: number, followed: AccountSync) =>
				run(
					sql`INSERT INTO accounts (id, mode, last_success_at, last_error) VALUES (${accountId}, ${followed.mode}, ${Option.getOrNull(Option.map(followed.lastSuccess, (at) => at.epochMilliseconds))}, ${Option.getOrNull(followed.error)})
					ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, last_success_at = excluded.last_success_at, last_error = excluded.last_error`
				);

			const removeAccount = (accountId: number) =>
				transaction(
					Effect.andThen(
						run(sql`DELETE FROM folders WHERE account_id = ${accountId}`),
						run(sql`DELETE FROM accounts WHERE id = ${accountId}`)
					)
				);

			const keepAccounts = Effect.fnUntraced(function* (
				kept: readonly number[]
			) {
				const ids = yield* encodeInts(kept).pipe(Effect.orDie);
				yield* transaction(
					Effect.andThen(
						run(
							sql`DELETE FROM folders WHERE account_id NOT IN (SELECT value FROM json_each(${ids}))`
						),
						run(
							sql`DELETE FROM accounts WHERE id NOT IN (SELECT value FROM json_each(${ids}))`
						)
					)
				);
			});

			return Store.of({
				accountSyncs,
				beat,
				byGraphId,
				byId,
				conversation,
				file,
				folders,
				hasFolder,
				heartbeat,
				keepAccounts,
				keepOnly,
				lookup,
				ownAddresses,
				placements,
				reindex,
				remove,
				removeAccount,
				saveAccountSync,
				saveFolder,
				saveFolders,
				saveInPlace,
				search,
				setDeltaLink,
				transaction,
			});
		})
	).pipe(Layer.provide(connection));
}
