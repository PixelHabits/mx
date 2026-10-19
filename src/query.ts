import { Database, SQLiteError } from "bun:sqlite";
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Layer,
	Path,
	pipe,
	Schema,
	String as Str,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AccountsFile, fallbackAlias } from "./auth/config.ts";
import { Refused } from "./errors.ts";
import { isOutlookLink } from "./outlook.ts";
import { Paths } from "./paths.ts";
import { aliasesTable, views } from "./store/views.ts";

/** The argument that makes mx answer one query: `mx query-worker`, the child process the `query` tool runs. */
export const queryWorker = "query-worker";

/**
 * How long a query may run. Bun's SQLite has no way to interrupt a statement, and a terminated Worker goes on running
 * it, so each query runs in a child process that mx kills when the time is up.
 */
const queryTimeout = Duration.seconds(10);

/** The most rows an answer holds, the most characters it holds, and the most characters of one value but an Outlook link. */
const maxRows = 200;
const maxCharacters = 20_000;
const maxValueLength = 200;

/**
 * What the worker reads on stdin: the store to open and the agent's SQL. The worker answers the mx mcp of an older
 * release, which an update leaves running on the new binary, so the request only gains optional fields.
 */
const Request = Schema.fromJsonString(
	Schema.Struct({ database: Schema.String, sql: Schema.String })
);

/** What the worker writes on stdout: the table, or why SQLite or mx refused the SQL. */
const Answer = Schema.fromJsonString(
	Schema.Union([
		Schema.Struct({ table: Schema.String }),
		Schema.Struct({ refused: Schema.String }),
	])
);

const lineBreaks = /[\t\r\n]+/gu;

/** A value as one cell of the table: NULL, a blob's size, or text on one line, cut at `maxValueLength` unless it is an Outlook link. */
const cell = (value: unknown) => {
	if (value === null) {
		return "NULL";
	}
	if (value instanceof Uint8Array) {
		return `(blob, ${value.byteLength} bytes)`;
	}
	const text = pipe(String(value), Str.replaceAll(lineBreaks, " "));
	return text.length > maxValueLength && !isOutlookLink(text)
		? `${pipe(text, Str.slice(0, maxValueLength - 1))}…`
		: text;
};

/**
 * The rows as a table: a header, then one line per row, tab-separated. It stops after `maxRows` rows or before
 * `maxCharacters`, whichever comes first, and its last line then says which.
 */
const table = (
	columns: readonly string[],
	rows: Iterable<Record<string, unknown>>
) => {
	const header = Arr.join(Arr.map(columns, cell), "\t");
	const lines = [header];
	let { length } = header;
	for (const row of rows) {
		if (lines.length > maxRows) {
			lines.push(`(first ${maxRows} rows; refine the query)`);
			break;
		}
		const line = Arr.join(
			Arr.map(columns, (column) => cell(row[column])),
			"\t"
		);
		length += 1 + line.length;
		if (length > maxCharacters) {
			lines.push(
				`(first ${lines.length - 1} rows, cut at ${maxCharacters} characters; refine the query)`
			);
			break;
		}
		lines.push(line);
	}
	return lines.length === 1 ? `${header}\n(no rows)` : Arr.join(lines, "\n");
};

/** An account the views show, by its id in the store, with the alias config.json gives it. */
interface Aliased {
	readonly alias: string;
	readonly id: number;
}

/** Without config.json mx names no account, and the mail a store holds is account 1's, which shows as main. */
const unnamed: readonly Aliased[] = [{ alias: fallbackAlias, id: 1 }];

/**
 * Selects `sql` from the store at `database`, opened read-only, so SQLite refuses every write; SQLite's refusal throws.
 * mx's SELECT around the SQL makes SQLite's parser refuse anything but one SELECT. Bun prepares only a statement's
 * first part and drops the rest unread, so SQL that ends the statement early, as with a `)` that closes mx's
 * parenthesis, is refused. A comment can still hide mx's LIMIT, so the table stops at `maxRows` itself.
 */
const select = (
	{ database, sql }: typeof Request.Type,
	accounts: readonly Aliased[]
): typeof Answer.Type => {
	const db = new Database(database, { readonly: true });
	db.run(aliasesTable);
	for (const { alias, id } of accounts) {
		db.run("INSERT INTO aliases (account_id, alias) VALUES (?, ?)", [
			id,
			alias,
		]);
	}
	for (const view of views) {
		db.run(view);
	}
	// The line break ends a `--` comment at the end of the SQL before mx's parenthesis.
	const wrapped = `SELECT * FROM (\n${sql}\n) LIMIT ${maxRows + 1}`;
	const statement = db.prepare<Record<string, unknown>, []>(wrapped);
	if (statement.paramsCount > 0) {
		return {
			refused: "query binds no parameters; write each value into the SQL.",
		};
	}
	if (statement.toString() !== wrapped) {
		return {
			refused:
				"SQLite ended the statement before the end of the SQL; query runs one SELECT with nothing after it.",
		};
	}
	return { table: table(statement.columnNames, statement.iterate()) };
};

/** The answer to the request over the views of `accounts`, with SQLite's own message when it refused the SQL. */
const answer = (
	request: typeof Request.Type,
	accounts: readonly Aliased[]
): typeof Answer.Type => {
	try {
		return select(request, accounts);
	} catch (error) {
		if (error instanceof SQLiteError) {
			return { refused: error.message };
		}
		throw error;
	}
};

/**
 * `mx query-worker`: reads a request on stdin, and writes its answer on stdout, SQLite's error verbatim when it refused.
 * The aliases come from config.json as it is now, so the views show an alias changed after mx mcp started.
 */
export const answerQuery = Effect.gen(function* () {
	const request = yield* Effect.promise(() => Bun.stdin.text()).pipe(
		Effect.flatMap(Schema.decodeEffect(Request)),
		Effect.orDie
	);
	const answered = yield* (yield* AccountsFile).read.pipe(
		Effect.map((accounts) =>
			answer(
				request,
				Arr.isReadonlyArrayNonEmpty(accounts) ? accounts : unnamed
			)
		),
		Effect.catchTag("CredentialFailed", ({ message }) =>
			Effect.succeed({ refused: message })
		)
	);
	const text = yield* Schema.encodeEffect(Answer)(answered).pipe(Effect.orDie);
	yield* Effect.promise(() => Bun.write(Bun.stdout, text));
});

/** One read-only SELECT over the views of the store, each in a child process of its own. */
export class Query extends Context.Service<
	Query,
	{
		/** The table the SQL selects; SQL that SQLite or mx refuses, or that runs past `queryTimeout`, is refused with why. */
		readonly run: (sql: string) => Effect.Effect<string, Refused>;
	}
>()("mx/query") {
	static readonly layer = Layer.effect(
		Query,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const path = yield* Path.Path;
			const { database } = yield* Paths;
			// The binary runs itself; from source, as in the tests, Bun runs mx's entry point.
			const args = Bun.isStandaloneExecutable
				? [queryWorker]
				: [path.join(import.meta.dir, "main.ts"), queryWorker];

			const run = Effect.fnUntraced(function* (sql: string) {
				const request = yield* Schema.encodeEffect(Request)({
					database,
					sql,
				}).pipe(Effect.orDie);
				const output = yield* spawner
					.string(
						ChildProcess.make(process.execPath, args, {
							// The worker's connection is read-only, so it has nothing to finish before it stops.
							killSignal: "SIGKILL",
							stderr: "inherit",
							stdin: Stream.make(new TextEncoder().encode(request)),
						})
					)
					.pipe(
						Effect.orDie,
						Effect.timeoutOrElse({
							duration: queryTimeout,
							orElse: () =>
								Refused.make({
									message: `The query ran past ${Duration.toSeconds(queryTimeout)} seconds, so mx stopped it. Narrow it down and run it again.`,
								}),
						})
					);
				const answered = yield* Schema.decodeEffect(Answer)(output).pipe(
					Effect.orDie
				);
				return "table" in answered
					? answered.table
					: yield* Refused.make({ message: answered.refused });
			});

			return Query.of({ run });
		})
	);
}
