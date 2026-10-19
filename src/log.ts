import { Database } from "bun:sqlite";
import {
	Array as Arr,
	Cause,
	Console,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Logger,
	LogLevel,
	Option,
	Schema,
} from "effect";
import { Paths } from "./paths.ts";
import { localTime } from "./temporal.ts";

/**
 * The most live data the log holds: its used pages times the page size, leaving out the free pages SQLite reuses for
 * the next rows. Past it, each write deletes the oldest rows, so the file stays near this size without a VACUUM.
 */
const maxBytes = 50 * 1024 * 1024;

/** How long SQLite waits while another mx process writes the log. Bun's SQLite waits synchronously, so all of mx waits. */
const busyTimeout = Duration.seconds(5);

/**
 * The log's one table. A call has agent through duration_ms, and a sync line level and message. AUTOINCREMENT never
 * gives an id twice, so mx log --follow finds each new row after the last id it printed.
 */
const createEntries = `CREATE TABLE IF NOT EXISTS entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	pid INTEGER NOT NULL,
	kind TEXT NOT NULL,
	agent TEXT,
	name TEXT,
	arguments TEXT,
	result TEXT,
	is_error INTEGER,
	duration_ms INTEGER,
	level TEXT,
	message TEXT
)`;

const insertCall = `INSERT INTO entries (at, pid, kind, agent, name, arguments, result, is_error, duration_ms)
	VALUES ($at, $pid, $kind, $agent, $name, $arguments, $result, $is_error, $duration_ms)`;

const insertSyncLine = `INSERT INTO entries (at, pid, kind, level, message)
	VALUES ($at, $pid, 'sync', $level, $message)`;

/** Deletes the `$rows` oldest rows if the log holds more than `$maxBytes` of live data. */
const deleteOldest = `DELETE FROM entries
	WHERE id IN (SELECT id FROM entries ORDER BY id LIMIT $rows)
	AND (
		SELECT (page_count - freelist_count) * page_size FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()
	) > $maxBytes`;

/**
 * The newest `$limit` entries that pass the filter, oldest first, or all of them with a negative `$limit`, which SQLite
 * reads as none. A NULL filter keeps every row.
 */
const selectEntries = `SELECT * FROM (
	SELECT * FROM entries
	WHERE ($sync OR kind != 'sync')
	AND ($name IS NULL OR name = $name)
	AND ($since IS NULL OR at >= $since)
	AND ($after IS NULL OR id > $after)
	ORDER BY id DESC LIMIT $limit
) ORDER BY id`;

/** Values bound to a statement's parameters of the same names. */
type Bindings = Record<string, string | number | boolean | null>;

/**
 * Runs `use` on the log at `file`, which it opens before and closes after, so no process holds the log open between
 * uses: Windows deletes no open file, and mx uninstall removes the log while agents run mx mcp. It creates no file, so
 * a log that was removed stays removed. `use` runs synchronously, so nothing else in this process runs while it holds
 * the log.
 */
const connected = <A>(file: string, use: (db: Database) => A) => {
	using db = new Database(file, { readwrite: true, strict: true });
	db.run(`PRAGMA busy_timeout = ${Duration.toMillis(busyTimeout)}`);
	return use(db);
};

/**
 * Deletes the oldest rows while the log holds more than `maxBytes` of live data. Each round deletes twice the rows of
 * the one before, so a large answer on a log of small rows takes few rounds, and it deletes fewer than twice the rows
 * it has to. It stops when the log fits or no row is left.
 */
const trim = (db: Database) => {
	const oldest = db.query<never, { maxBytes: number; rows: number }>(
		deleteOldest
	);
	let rows = 1;
	while (oldest.run({ maxBytes, rows }).changes > 0) {
		rows *= 2;
	}
};

/**
 * Inserts `columns` into the log at `file` with `insert`, then trims the log, in one transaction that takes the write
 * lock as it begins.
 */
const append = (file: string, insert: string, columns: Bindings) =>
	connected(file, (db) =>
		db
			.transaction(() => {
				db.query<never, Bindings>(insert).run(columns);
				trim(db);
			})
			.immediate()
	);

/** An agent as it names itself to MCP, such as `claude-code 2.1.0`. */
const Agent = Schema.Struct({ name: Schema.String, version: Schema.String });
export type Agent = typeof Agent.Type;

/** A `tools/call` or `prompts/get` that mx answered. */
export interface Call {
	/** None when the agent did not name itself. */
	readonly agent: Option.Option<Agent>;
	/** What the agent sent, as JSON. */
	readonly arguments: unknown;
	/** When the agent asked. */
	readonly at: Temporal.Instant;
	readonly duration: Duration.Duration;
	readonly isError: boolean;
	readonly kind: "tool" | "prompt";
	/** The tool or prompt. */
	readonly name: string;
	/** The whole text mx answered, or how the call failed. */
	readonly result: string;
}

/** A line that mx sync logged. */
export interface SyncLine {
	readonly at: Temporal.Instant;
	readonly kind: "sync";
	readonly level: LogLevel.LogLevel;
	readonly message: string;
}

export type Entry = Call | SyncLine;

/** An entry as the log holds it, with its row id and the process that wrote it. */
export type Logged = Entry & { readonly id: number; readonly pid: number };

/** A row of `entries` as SQLite returns it: a call or a sync line by its kind. */
const Row = Schema.Union([
	Schema.Struct({
		agent: Schema.NullOr(Schema.fromJsonString(Agent)),
		arguments: Schema.fromJsonString(Schema.Unknown),
		at: Schema.Int,
		duration_ms: Schema.Int,
		id: Schema.Int,
		is_error: Schema.Literals([0, 1]),
		kind: Schema.Literals(["tool", "prompt"]),
		name: Schema.String,
		pid: Schema.Int,
		result: Schema.String,
	}),
	Schema.Struct({
		at: Schema.Int,
		id: Schema.Int,
		kind: Schema.Literal("sync"),
		level: Schema.Literals(LogLevel.values),
		message: Schema.String,
		pid: Schema.Int,
	}),
]);

const logged = (row: typeof Row.Type): Logged => {
	const at = Temporal.Instant.fromEpochMilliseconds(row.at);
	if (row.kind === "sync") {
		const { id, level, message, pid } = row;
		return { at, id, kind: "sync", level, message, pid };
	}
	return {
		agent: Option.fromNullishOr(row.agent),
		arguments: row.arguments,
		at,
		duration: Duration.millis(row.duration_ms),
		id: row.id,
		isError: row.is_error === 1,
		kind: row.kind,
		name: row.name,
		pid: row.pid,
		result: row.result,
	};
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeAgent = Schema.encodeEffect(Schema.fromJsonString(Agent));

/** The columns of `call`, written by this process. */
const callColumns = (call: Call) =>
	Effect.gen(function* () {
		return {
			agent: Option.isSome(call.agent)
				? yield* encodeAgent(call.agent.value)
				: null,
			arguments: yield* encodeJson(call.arguments),
			at: call.at.epochMilliseconds,
			duration_ms: Math.round(Duration.toMillis(call.duration)),
			is_error: call.isError ? 1 : 0,
			kind: call.kind,
			name: call.name,
			pid: process.pid,
			result: call.result,
		};
	});

/** A logged value as text: a string as it is, anything else as Effect formats it. */
const valueText = (value: unknown) =>
	typeof value === "string" ? value : Formatter.format(value);

/** The columns of the line mx sync logged with `options`, written by this process, with its cause when it has one. */
const syncLineColumns = ({
	cause,
	date,
	logLevel,
	message,
}: Logger.Options<unknown>) => ({
	at: date.getTime(),
	level: logLevel,
	message: Arr.join(
		[
			...Arr.map(Arr.ensure(message), valueText),
			...(Arr.isReadonlyArrayNonEmpty(cause.reasons)
				? [Cause.pretty(cause)]
				: []),
		],
		" "
	),
	pid: process.pid,
});

/**
 * The log of every tool call, prompt and mx sync line, in `log.sqlite` in the state folder, which only the user can read.
 * Each mx process writes to it: every `mx mcp` an agent runs, and `mx sync`.
 */
export class Log extends Context.Service<
	Log,
	{
		/**
		 * Writes `call` to the log, then deletes the oldest rows while the log is over its size. It never fails: a failed
		 * write is reported on stderr, since nothing that writes to the log may fail for it.
		 */
		readonly write: (call: Call) => Effect.Effect<void>;
		/**
		 * A logger that writes each line mx logs to the log as a sync line, with its cause when it has one, as it logs it,
		 * so a forced kill such as `taskkill /F` loses at most the line it writes. It reports a failed write on stderr as
		 * `write` does.
		 */
		readonly syncLogger: Logger.Logger<unknown, void>;
		/**
		 * The newest `limit` entries that pass the filter, oldest first, or all of them without a limit. Without `sync` it
		 * leaves out mx sync's lines; `name` keeps the calls of one tool or prompt, `since` the entries from that instant
		 * on, and `after` the rows after that id.
		 */
		readonly read: (filter: {
			readonly after: Option.Option<number>;
			readonly limit: Option.Option<number>;
			readonly name: Option.Option<string>;
			readonly since: Option.Option<Temporal.Instant>;
			readonly sync: boolean;
		}) => Effect.Effect<readonly Logged[]>;
	}
>()("mx/log") {
	/**
	 * Creates the log with only the user's access, and its table. A log that cannot be set up is reported on stderr and
	 * fails nothing, as a failed write does.
	 */
	static readonly layer = Layer.effect(
		Log,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { log, state } = yield* Paths;
			const console = yield* Console.Console;

			const report = (cause: Cause.Cause<unknown>) =>
				console.error(
					`mx could not write to its log ${log}: ${Cause.pretty(cause)}`
				);
			const reported = (cause: Cause.Cause<unknown>) =>
				Effect.sync(() => report(cause));

			/** Appends `columns` with `insert`, and reports a failure. */
			const appended = (insert: string, columns: Bindings) => {
				try {
					append(log, insert, columns);
				} catch (error) {
					report(Cause.die(error));
				}
			};

			// SQLite gives the journal it makes the mode of the log.
			yield* Effect.gen(function* () {
				yield* fs.makeDirectory(state, { mode: 0o700, recursive: true });
				yield* fs.writeFile(log, new Uint8Array(), { flag: "a", mode: 0o600 });
				yield* Effect.try(() => connected(log, (db) => db.run(createEntries)));
			}).pipe(Effect.catchCause(reported));

			const write = (call: Call) =>
				callColumns(call).pipe(
					Effect.flatMap((columns) =>
						Effect.sync(() => appended(insertCall, columns))
					),
					Effect.catchCause(reported)
				);

			const syncLogger = Logger.make((options) =>
				appended(insertSyncLine, syncLineColumns(options))
			);

			const read: Log["Service"]["read"] = (filter) =>
				Effect.try(() =>
					connected(log, (db) =>
						db.query<unknown, Bindings>(selectEntries).all({
							after: Option.getOrNull(filter.after),
							limit: Option.getOrElse(filter.limit, () => -1),
							name: Option.getOrNull(filter.name),
							since: Option.getOrNull(
								Option.map(filter.since, (at) => at.epochMilliseconds)
							),
							sync: filter.sync,
						})
					)
				).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
					Effect.map(Arr.map(logged)),
					Effect.orDie
				);

			return Log.of({ read, syncLogger, write });
		})
	);
}

/** Text whose every line after the first is indented by `indent`, so it reads as one block. */
const block = (text: string, indent: string) =>
	text.replaceAll("\n", `\n${indent}`);

/**
 * `mx log`'s text for one entry, in the local time zone. A call is a header line, then what the agent sent and what mx
 * answered, each indented two spaces; a sync line is one line.
 */
export const entryText = (entry: Logged) =>
	Effect.gen(function* () {
		const at = localTime(entry.at, "second");
		if (entry.kind === "sync") {
			return `${at} sync ${entry.level.toLowerCase()}: ${block(entry.message, "  ")}`;
		}
		const agent = Option.match(entry.agent, {
			onNone: () => "unknown agent",
			onSome: ({ name, version }) => `${name} ${version}`,
		});
		const outcome = entry.isError ? "error" : "ok";
		return Arr.join(
			[
				`${at} ${agent} ${entry.kind} ${entry.name} (${outcome}, ${Duration.toMillis(entry.duration)} ms)`,
				`  arguments: ${yield* encodeJson(entry.arguments)}`,
				`  result: ${block(entry.result, "    ")}`,
			],
			"\n"
		);
	}).pipe(Effect.orDie);

/** `mx log --json`'s line for one entry: one JSON object with every field, its time a UTC instant. */
export const entryJson = (entry: Logged) =>
	encodeJson(
		entry.kind === "sync"
			? {
					at: entry.at.toString(),
					id: entry.id,
					kind: entry.kind,
					level: entry.level,
					message: entry.message,
					pid: entry.pid,
				}
			: {
					agent: Option.getOrNull(entry.agent),
					arguments: entry.arguments,
					at: entry.at.toString(),
					durationMs: Duration.toMillis(entry.duration),
					id: entry.id,
					isError: entry.isError,
					kind: entry.kind,
					name: entry.name,
					pid: entry.pid,
					result: entry.result,
				}
	).pipe(Effect.orDie);
