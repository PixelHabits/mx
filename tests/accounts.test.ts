import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a spawn hook runs synchronously as the program starts, so it reads config.json synchronously.
import { readFileSync } from "node:fs";
import { BunServices } from "@effect/platform-bun";
import {
	Array as Arr,
	type Cause,
	ConfigProvider,
	Context,
	Duration,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	ManagedRuntime,
	Option,
	Path,
	pipe,
	Queue,
	Schema,
	String as Str,
	Terminal,
} from "effect";
import { Command, TerminalCapabilities } from "effect/cli";
import { TestConsole } from "effect/testing";
import { mx, run as runMx } from "../src/cli.ts";
import { Paths } from "../src/paths.ts";
import {
	type FakeMailbox,
	FakeMicrosoft,
	loginHost,
} from "./fake-microsoft.ts";
import { FakeProcesses } from "./fake-processes.ts";
import { FakeReleases } from "./fake-releases.ts";
import { FakeSecrets } from "./fake-secrets.ts";
import { connect, McpClient } from "./mcp-client.ts";

/** The temporary home every folder of this machine sits in. */
class Home extends Context.Service<Home, string>()(
	"mx/tests/accounts.test/Home"
) {}

const machine = ManagedRuntime.make(
	Layer.effect(
		Home,
		Effect.flatMap(FileSystem.FileSystem, (fs) =>
			fs.makeTempDirectoryScoped({ prefix: "mx-accounts-" })
		)
	).pipe(Layer.provideMerge(BunServices.layer))
);
const home = await machine.runPromise(Home);
const { join } = await machine.runPromise(Path.Path);

const microsoft = new FakeMicrosoft(await FakeReleases.make());
const processes = new FakeProcesses(microsoft.tunnels);
const secrets = new FakeSecrets();
secrets.install();
// bun test run in a terminal hands it stdin and stdout, so mx's are terminals only in a test that says so.
for (const stream of [process.stdin, process.stdout]) {
	Object.defineProperty(stream, "isTTY", { configurable: true, value: false });
}

/** Sam's mailbox, which the first account signs in to, and the mailboxes of Pat and Ana. */
const sam = microsoft.mailbox;
const pat = microsoft.addMailbox("pat", {
	address: "pat@example.org",
	name: "Pat Example",
});
const ana = microsoft.addMailbox("ana", {
	address: "ana@example.net",
	name: "Ana Example",
});

/** The client ids the accounts sign in with, and the first account's tenant. */
const clientId = "11111111-2222-4333-8444-555555555555";
const otherClientId = "66666666-7777-4888-9999-000000000000";
const thirdClientId = "33333333-4444-4555-8666-777777777777";
const tenant = "contoso.com";

const graphScope =
	"https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";
const identityScope = `${graphScope} openid email profile`;
const aliasRule =
	"An alias is up to 20 lowercase letters, digits and hyphens, and starts with a letter, such as work.";

/**
 * What every mx process runs on: Microsoft, Bun with faked child processes, a console that keeps its lines, Config
 * over `env`, and the terminal's capabilities from `env` and the TTY state of stdin and stdout.
 */
const platformWith = (env: Record<string, string>) => {
	const config = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
	return Layer.mergeAll(
		microsoft.layer,
		BunServices.layer,
		processes.layer(env),
		TestConsole.layer,
		config,
		TerminalCapabilities.layer.pipe(
			Layer.provide(Layer.merge(BunServices.layer, config))
		)
	);
};
type Platform = ReturnType<typeof platformWith>;

/** Runs `mx <args>` as a process of its own on `system`: how it exited, and what it printed to stdout and stderr. */
const runOn =
	(system: Platform) =>
	(...args: string[]) =>
		Effect.exit(runMx(args)).pipe(
			Effect.flatMap((exit) =>
				Effect.map(
					Effect.all({
						errors: TestConsole.errorLines,
						output: TestConsole.logLines,
					}),
					({ errors, output }) => ({
						errors: Arr.join(Arr.map(errors, String), "\n"),
						exit,
						output: Arr.join(Arr.map(output, String), "\n"),
					})
				)
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - each call is the entry point of one mx process.
			Effect.provide(system, { local: true })
		);

/** Runs `mx <args>` and answers what it printed to stdout; when mx fails, this fails with mx's error. */
const cliOn =
	(system: Platform) =>
	(...args: string[]) =>
		Effect.flatMap(runOn(system)(...args), ({ exit, output }) =>
			Effect.as(exit, { output })
		);

/**
 * A machine whose home is `root`: the environment of its mx processes, with their folders below it and no client id or
 * tenant, what they run on, `run` and `cli` there, and where mx keeps config.json and the store.
 */
const machineAt = (root: string) =>
	Effect.gen(function* () {
		const environment = {
			APPDATA: join(root, "AppData", "Roaming"),
			HOME: root,
			LOCALAPPDATA: join(root, "AppData", "Local"),
			PATH: join(root, "path"),
			USERPROFILE: root,
			XDG_CACHE_HOME: join(root, "cache"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "state"),
		};
		const platform = platformWith(environment);
		// @effect-diagnostics-next-line strictEffectProvide:off - where mx keeps its files on this machine.
		const { configFile, database } = yield* Effect.provide(
			Paths.make,
			ConfigProvider.layer(ConfigProvider.fromUnknown(environment))
		);
		return {
			cli: cliOn(platform),
			configFile,
			database,
			environment,
			home: root,
			platform,
			run: runOn(platform),
		};
	});

/** The machine of the tests about accounts and their sign-ins. */
const { cli, configFile, database, platform, run } = await machine.runPromise(
	machineAt(home)
);

/** `mx mcp` as an agent starts it, one process for every test, with a client on its stdio. */
const server = ManagedRuntime.make(
	Layer.effect(
		McpClient,
		Effect.gen(function* () {
			const { client, stdio } = yield* connect();
			yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of the mx mcp process.
				Effect.provide(stdio),
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of the mx mcp process.
				Effect.provide(platform, { local: true }),
				Effect.forkScoped
			);
			return client;
		})
	).pipe(Layer.provideMerge(platform))
);

afterAll(() => server.dispose().then(() => machine.dispose()));

const testTimeout = Duration.seconds(30);

/** One test, on mx's own runtime, which interrupts it at `testTimeout`. */
const test = <E>(
	name: string,
	body: () => Effect.Effect<void, E, Layer.Success<Platform> | McpClient>
) =>
	it(
		name,
		() => server.runPromise(Effect.timeout(body(), testTimeout)),
		Duration.toMillis(Duration.times(testTimeout, 2))
	);

/** Sets whether mx's stdin and stdout are terminals. */
const setTerminal = (isTTY: boolean) =>
	Effect.sync(() => {
		for (const stream of [process.stdin, process.stdout]) {
			Object.defineProperty(stream, "isTTY", {
				configurable: true,
				value: isTTY,
			});
		}
	});

/** Runs `effect` with mx's stdin and stdout terminals. */
const onTerminal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		setTerminal(true),
		() => effect,
		() => setTerminal(false)
	);

/** A key of one character types it, and a longer one, such as `return`, presses the key of that name. */
const keyPress = (name: string): Terminal.UserInput => ({
	input: name.length === 1 ? Option.some(name) : Option.none(),
	key: { ctrl: false, meta: false, name, shift: false },
});

/**
 * `base` on a terminal where the user presses `keys` in turn across every prompt; `frames` keeps what mx drew, and
 * `drawn` runs on each frame as mx draws it, before the user presses the next key.
 */
const terminalWith = (
	keys: readonly string[],
	drawn: (frame: string) => void = () => undefined,
	base: Platform = platform
) => {
	const frames: string[] = [];
	let input: Queue.Queue<Terminal.UserInput, Cause.Done> | undefined;
	const terminal = Layer.succeed(
		Terminal.Terminal,
		Terminal.make({
			columns: Effect.succeed(80),
			display: (text) =>
				Effect.sync(() => {
					frames.push(text);
					drawn(text);
				}),
			readInput: Effect.gen(function* () {
				if (input === undefined) {
					input = yield* Queue.make<Terminal.UserInput, Cause.Done>();
					yield* Queue.offerAll(input, Arr.map(keys, keyPress));
				}
				return input;
			}),
			readLine: Effect.die("mx reads no lines from the terminal."),
			rows: Effect.succeed(24),
		})
	);
	return { frames, system: Layer.merge(base, terminal) };
};

/** The keys that type `text`. */
const typing = (text: string) => [...text];
/** The keys that erase `count` characters. */
const erasing = (count: number) => Arr.replicate("backspace", count);

const call = (name: string, args: Record<string, unknown>) =>
	McpClient.use((client) => client.call(name, args));

/** A tool's text; a tool error fails the test with the error's text. */
const tool = (name: string, args: Record<string, unknown>) =>
	Effect.flatMap(call(name, args), ({ isError, text }) =>
		isError
			? Effect.die(`${name} answered an error: ${text}`)
			: Effect.succeed(text)
	);

const lines = (text: string): string[] => pipe(text, Str.split("\n"));

/** The last two lines of a query's table: its header and its one row. */
const oneRow = (sql: string) =>
	Effect.map(tool("query", { sql }), (table) => lines(table).slice(-2));

const parseJson = (text: string) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.orDie
	);
const readJson = (file: string) =>
	Effect.flatMap(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)),
		parseJson
	);
const writeJson = (file: string, value: unknown) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.writeFileString(file, JSON.stringify(value, null, 2))
	);

const SavedSignIn = Schema.fromJsonString(
	Schema.Struct({
		clientId: Schema.String,
		refreshToken: Schema.String,
		tenant: Schema.String,
	})
);

/** The client id, tenant and refresh token of the sign-in saved under `name` in the secret store. */
const signInSaved = (name: string) =>
	Schema.decodeUnknownEffect(SavedSignIn)(
		secrets.entries.get(`mx/${name}`)
	).pipe(Effect.orDie);

/** Each request to Microsoft's sign-in host: its endpoint, tenant, client id, grant and scope. */
const signInRequests = () =>
	Arr.map(
		Arr.filter(microsoft.received, ({ url }) => url.hostname === loginHost),
		({ body, url }) => {
			const form = new URLSearchParams(body);
			const path = pipe(url.pathname, Str.split("/"));
			return {
				clientId: form.get("client_id"),
				endpoint: path.at(-1),
				grant: form.get("grant_type"),
				scope: form.get("scope"),
				tenant: path[1],
			};
		}
	);
const refreshes = (from: number) =>
	Arr.filter(
		signInRequests().slice(from),
		({ grant }) => grant === "refresh_token"
	);
const deviceCodes = (from: number) =>
	Arr.filter(
		signInRequests().slice(from),
		({ endpoint }) => endpoint === "devicecode"
	);

const listedId = /^#(\d+) /u;

/** The local id of the message whose search line contains `subject`. */
const idOf = (listing: string, subject: string) =>
	Number(
		listedId.exec(
			Arr.findFirst(lines(listing), Str.includes(subject)).pipe(
				Option.getOrElse(() => "")
			)
		)?.[1]
	);

/** Sam's account as config.json names it once mx knows who signed in to it. */
const samAccount = (alias: string) => ({
	address: sam.user.address,
	alias,
	clientId,
	id: 1,
	oid: sam.oid,
	tenant,
	tid: sam.tid,
});
const patAccount = {
	address: pat.user.address,
	alias: "personal",
	clientId: otherClientId,
	id: 2,
	oid: pat.oid,
	tenant: "example.org",
	tid: pat.tid,
};

/**
 * The program mx asks whether mx install registered mx sync to start at sign-in, which answers that it did unless it
 * fails; on macOS mx looks for the LaunchAgent's plist instead, which a machine here has only once a test writes it.
 */
const asksRegistered = process.platform === "win32" ? "reg" : "systemctl";

describe("accounts", () => {
	test("a config.json and a sign-in that the release before saved go on working with no new sign-in: mx sync and mx mcp refresh the sign-in with the Graph scopes alone, query shows the account by the first label of its tenant, and nothing rewrites config.json", () =>
		Effect.gen(function* () {
			yield* cli("login", "--client-id", clientId, "--tenant", tenant);
			// What the release before saves: the client id and the tenant, and the sign-in as refresh-token.
			yield* writeJson(configFile, { clientId, tenant });
			const before = signInRequests().length;
			yield* cli("sync", "--once");
			const found = yield* tool("search", { query: "budget" });
			yield* tool("message", {
				full: true,
				id: idOf(found, "Quarterly budget"),
			});
			expect(yield* oneRow("SELECT DISTINCT account FROM mail")).toEqual([
				"account",
				"contoso",
			]);
			expect(lines((yield* run("status")).output)).toContain("Account contoso");
			expect(deviceCodes(before)).toEqual([]);
			expect(Arr.isReadonlyArrayNonEmpty(refreshes(before))).toBe(true);
			expect(
				Arr.every(
					refreshes(before),
					(request) =>
						request.clientId === clientId &&
						request.tenant === tenant &&
						request.scope === graphScope
				)
			).toBe(true);
			expect(yield* readJson(configFile)).toEqual({ clientId, tenant });
		}));

	test("mx login --account adds an account with its own client id and tenant, saves its sign-in as refresh-token-2 and who signed in, learns who the first account is with one refresh under that account's client id, names the accounts and mx rename, and where mx install never set up mx sync, syncs none of its mail and says to run mx install", () =>
		Effect.gen(function* () {
			processes.failing.add(asksRegistered);
			microsoft.signingIn = pat;
			const before = signInRequests().length;
			const asked = microsoft.graphRequests().length;
			const { output } = yield* cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			expect(
				Arr.filter(microsoft.graphRequests().slice(asked), ({ url }) =>
					pipe(url.pathname, Str.endsWith("/messages/delta"))
				)
			).toEqual([]);
			expect(lines(output).at(-1)).toBe(
				"Added personal. mx sync is not set up here, so nothing copies its mail yet. Run mx install to start it."
			);
			expect(refreshes(before)).toEqual([
				{
					clientId,
					endpoint: "token",
					grant: "refresh_token",
					scope: identityScope,
					tenant,
				},
			]);
			expect(deviceCodes(before)).toEqual([
				{
					clientId: otherClientId,
					endpoint: "devicecode",
					grant: null,
					scope: identityScope,
					tenant: "example.org",
				},
			]);
			expect(yield* readJson(configFile)).toEqual({
				accounts: [samAccount("contoso"), patAccount],
			});
			const first = yield* signInSaved("refresh-token");
			expect([first.clientId, first.tenant]).toEqual([clientId, tenant]);
			expect(first.refreshToken).toBe(sam.refreshTokens.at(-1) ?? "none");
			const second = yield* signInSaved("refresh-token-2");
			expect([second.clientId, second.tenant]).toEqual([
				otherClientId,
				"example.org",
			]);
			expect(second.refreshToken).toBe(pat.refreshTokens.at(-1) ?? "none");
			expect(lines(output)).toContain(
				"The accounts are contoso (sam@example.test) and personal (pat@example.org). To rename one, run mx rename <alias> <new alias>."
			);
			// The refresh that learned who the first account is replaced the access token mx mcp held for it.
			const afterLogin = signInRequests().length;
			const found = yield* tool("search", { query: "budget" });
			yield* tool("message", {
				full: true,
				id: idOf(found, "Quarterly budget"),
			});
			expect(refreshes(afterLogin)).toEqual([
				{
					clientId,
					endpoint: "token",
					grant: "refresh_token",
					scope: graphScope,
					tenant,
				},
			]);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					processes.failing.delete(asksRegistered);
				})
			)
		));

	test("mx login refuses to add a mailbox that is already an account, and saves nothing", () =>
		Effect.gen(function* () {
			microsoft.signingIn = pat;
			const before = yield* readJson(configFile);
			const failure = yield* Effect.flip(
				cli(
					"login",
					"--account",
					"again",
					"--client-id",
					otherClientId,
					"--tenant",
					"example.org"
				)
			);
			expect(failure.message).toBe(
				"pat@example.org is already the account personal. mx saved nothing."
			);
			expect(yield* readJson(configFile)).toEqual(before);
			expect(secrets.entries.has("mx/refresh-token-3")).toBe(false);
		}));

	test("mx login --account refuses an alias that breaks the rules, and on a terminal with two accounts mx login asks which one, and for a new one asks its alias, refusing one that breaks the rules or is taken, and saves who signed in", () =>
		Effect.gen(function* () {
			const before = yield* readJson(configFile);
			const refused = yield* Effect.flip(
				cli("login", "--account", "Work", "--tenant", "example.net")
			);
			expect(refused.message).toBe(`Work cannot be an alias. ${aliasRule}`);
			expect(yield* readJson(configFile)).toEqual(before);
			microsoft.signingIn = ana;
			const { frames, system } = terminalWith([
				"down",
				"down",
				"return",
				"W",
				"return",
				"backspace",
				...typing("personal"),
				"return",
				...erasing("personal".length),
				...typing("travel"),
				"return",
			]);
			yield* onTerminal(
				cliOn(system)(
					"login",
					"--client-id",
					thirdClientId,
					"--tenant",
					"example.net"
				)
			);
			const drawn = Arr.join(frames, "");
			expect(drawn).toContain("contoso (sam@example.test)");
			expect(drawn).toContain("personal (pat@example.org)");
			expect(drawn).toContain("Add an account");
			expect(drawn).toContain(aliasRule);
			expect(drawn).toContain("personal is already an account.");
			expect(yield* readJson(configFile)).toEqual({
				accounts: [
					samAccount("contoso"),
					patAccount,
					{
						address: ana.user.address,
						alias: "travel",
						clientId: thirdClientId,
						id: 3,
						oid: ana.oid,
						tenant: "example.net",
						tid: ana.tid,
					},
				],
			});
			expect((yield* signInSaved("refresh-token-3")).clientId).toBe(
				thirdClientId
			);
		}));

	test("mx rename gives an account a new alias, which query shows at once, and refuses an alias that breaks the rules or is taken, and an account that does not exist", () =>
		Effect.gen(function* () {
			expect((yield* cli("rename", "contoso", "work")).output).toBe(
				"Renamed contoso to work."
			);
			expect(yield* oneRow("SELECT DISTINCT account FROM mail")).toEqual([
				"account",
				"work",
			]);
			const refusals = yield* Effect.forEach(
				[
					["work", "personal"],
					["nobody", "home"],
					["work", "Home"],
				],
				([from = "", to = ""]) =>
					Effect.map(
						Effect.flip(cli("rename", from, to)),
						({ message }) => message
					)
			);
			expect(refusals).toEqual([
				"personal is already an account.",
				"No account nobody. The accounts are work, personal, and travel.",
				`Home cannot be an alias. ${aliasRule}`,
			]);
			expect(
				Arr.map(
					(
						(yield* readJson(configFile)) as {
							accounts: readonly { alias: string }[];
						}
					).accounts,
					({ alias }) => alias
				)
			).toEqual(["work", "personal", "travel"]);
		}));

	test("query shows the mail and folders of an account that config.json does not name, by the account's id", () =>
		Effect.gen(function* () {
			yield* Effect.sync(() => {
				const db = new Database(database, { strict: true });
				db.run(
					"INSERT INTO folders (id, parent_id, name, path, sent, delta_link, account_id) VALUES ('nine-inbox', 'nine-root', 'Inbox', 'Inbox', 0, NULL, 9)"
				);
				db.run("INSERT INTO local_ids (graph_id) VALUES ('nine-message')");
				db.run(
					`INSERT INTO messages (id, graph_id, folder_id, conversation_id, internet_message_id, from_name, from_address, to_list, cc_list, bcc_list, subject, received_at, sent_at, is_read, is_draft, flag, categories, importance, has_attachments, body)
					VALUES ((SELECT id FROM local_ids WHERE graph_id = 'nine-message'), 'nine-message', 'nine-inbox', 'conversation-loan', NULL, 'Rosa Example', 'rosa@example.com', '[]', '[]', '[]', 'Library loan reminder', 0, 0, 0, 0, 'notFlagged', '[]', 'normal', 0, 'The pruning book is due back on Friday.')`
				);
				db.close();
			});
			expect(
				yield* oneRow(
					"SELECT account, subject FROM mail WHERE account != 'work'"
				)
			).toEqual(["account\tsubject", "account 9\tLibrary loan reminder"]);
			expect(
				yield* oneRow(
					"SELECT account, path, total FROM folders WHERE account NOT IN ('work', 'personal', 'travel')"
				)
			).toEqual(["account\tpath\ttotal", "account 9\tInbox\t1"]);
		}));

	test("mx status shows each account with who signed in, its sign-in, client id and tenant, and mx uninstall removes every account's sign-in", () =>
		Effect.gen(function* () {
			const report = lines((yield* run("status")).output);
			expect(
				report.slice(report.indexOf("Account work: sam@example.test"))
			).toEqual([
				"Account work: sam@example.test",
				"Last sync: never",
				"Mode: starting",
				"Sign-in: saved",
				`Client id: ${clientId}`,
				`Tenant: ${tenant}`,
				"Last error: none",
				"Account personal: pat@example.org",
				"Last sync: never",
				"Mode: unknown",
				"Sign-in: saved",
				`Client id: ${otherClientId}`,
				"Tenant: example.org",
				"Last error: none",
				"Account travel: ana@example.net",
				"Last sync: never",
				"Mode: unknown",
				"Sign-in: saved",
				`Client id: ${thirdClientId}`,
				"Tenant: example.net",
				"Last error: none",
			]);
			const { output } = yield* cli("uninstall", "--yes");
			for (const alias of ["work", "personal", "travel"]) {
				expect(lines(output)).toContain(
					`Removed the saved sign-in of ${alias}.`
				);
			}
			expect(
				Arr.filter([...secrets.entries.keys()], Str.startsWith("mx/"))
			).toEqual([]);
		}));

	test("mx uninstall removes account 1's sign-in when there is no config.json, as after the user deletes a config.json that an earlier mx cannot read", () =>
		Effect.gen(function* () {
			microsoft.signingIn = sam;
			yield* cli("login", "--client-id", clientId, "--tenant", tenant);
			yield* (yield* FileSystem.FileSystem).remove(configFile);
			const { output } = yield* cli("uninstall", "--yes");
			expect(lines(output)).toContain(
				"Removed the saved sign-in of account 1."
			);
			expect(secrets.entries.has("mx/refresh-token")).toBe(false);
		}));

	test("an mx uninstall that fails partway, here as the secret store goes down while the user reads the list, leaves what tells mx the sign-ins, and a rerun removes the sign-in of every account", () =>
		Effect.gen(function* () {
			microsoft.signingIn = sam;
			yield* cli("login", "--client-id", clientId, "--tenant", tenant);
			microsoft.signingIn = pat;
			yield* cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			const { system } = terminalWith(["y"], () => {
				secrets.machine = "broken";
			});
			const { exit } = yield* onTerminal(runOn(system)("uninstall"));
			secrets.machine = "store";
			expect(Exit.isFailure(exit)).toBe(true);
			expect(secrets.entries.has("mx/refresh-token")).toBe(true);
			const { output } = yield* cli("uninstall", "--yes");
			for (const alias of ["contoso", "personal"]) {
				expect(lines(output)).toContain(
					`Removed the saved sign-in of ${alias}.`
				);
			}
			expect(
				Arr.filter([...secrets.entries.keys()], Str.startsWith("mx/"))
			).toEqual([]);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					secrets.machine = "store";
				})
			)
		));
});

/**
 * The machine of the tests from here on, with a home of its own, so they start where mx never synced: on Windows, mx
 * uninstall keeps the store while an mx mcp holds it open, as this file's mx mcp does.
 */
const second = await machine.runPromise(machineAt(join(home, "second")));

/** Someone who writes to Pat. */
const rosa = { address: "rosa@example.com", name: "Rosa Example" };

/**
 * The cloudflared `MX_CLOUDFLARED` names on `pushing`; the fake processes run it as a quick tunnel, and it reports
 * 2026.10.3.
 */
const cloudflared = join(home, "bin", "cloudflared");
processes.versions.set(cloudflared, "2026.10.3");

/** The second machine's platform with cloudflared, so mx sync runs push. */
const pushing = platformWith({
	...second.environment,
	MX_CLOUDFLARED: cloudflared,
});

/** The mx sync processes that run on from one test into the next. */
const services: Fiber.Fiber<unknown, unknown>[] = [];

/** Rows of the store, read as `sql` with `values` answers them. */
const rowsOf = <Row>(sql: string, ...values: (number | string)[]): Row[] => {
	const db = new Database(second.database, { strict: true });
	try {
		return db.query<Row, (number | string)[]>(sql).all(...values);
	} finally {
		db.close();
	}
};

interface Mail {
	readonly folder_id: string;
	readonly graph_id: string;
	readonly subject: string;
}

const byGraphId = (rows: readonly Mail[]) =>
	[...rows].sort((a, b) => pipe(a.graph_id, Str.localeCompare(b.graph_id)));

/** The mail the store files under the account, by Graph id. */
const mailOf = (account: number) =>
	byGraphId(
		rowsOf<Mail>(
			"SELECT m.graph_id, m.folder_id, m.subject FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.account_id = ?",
			account
		)
	);

/** The mail Graph holds in `mailbox`, as the store files it. */
const mailIn = (mailbox: FakeMailbox) =>
	byGraphId(
		Arr.map([...mailbox.messages.values()], (message) => ({
			folder_id: message.parentFolderId,
			graph_id: message.id,
			subject: message.subject,
		}))
	);

/** The folders the store files under the account, with their delta links, by id. */
const foldersOf = (account: number) =>
	rowsOf<{ readonly delta_link: string | null; readonly id: string }>(
		"SELECT id, delta_link FROM folders WHERE account_id = ? ORDER BY id",
		account
	);

/** The ids of the folders Graph holds in `mailbox`, in the order `foldersOf` lists them. */
const folderIdsIn = (mailbox: FakeMailbox) =>
	[...mailbox.folders.keys()].sort((a, b) => (a < b ? -1 : 1));

/** What the store holds of the account: its folders with their delta links, and its mail. */
const accountRows = (account: number) => ({
	folders: foldersOf(account),
	mail: mailOf(account),
});

/** How mx sync last recorded that it follows the account. */
const followed = (account: number) =>
	Arr.head(
		rowsOf<{ readonly last_error: string | null; readonly mode: string }>(
			"SELECT mode, last_error FROM accounts WHERE id = ?",
			account
		)
	);

/** The delta requests Graph had for the folder. */
const deltaRequests = (folderId: string) =>
	Arr.filter(microsoft.graphRequests(), ({ url }) =>
		pipe(url.pathname, Str.endsWith(`/${folderId}/messages/delta`))
	).length;

/** The subscriptions of `mailbox` on a quick tunnel. */
const tunnelSubscriptions = (mailbox: FakeMailbox) =>
	Arr.filter([...mailbox.subscriptions.byId.values()], (subscription) =>
		pipe(subscription.notificationUrl, Str.endsWith(".trycloudflare.com/graph"))
	);

/** The lines mx sync logged, oldest first. */
const syncLines = Effect.flatMap(
	second.cli("log", "--sync", "--json", "--limit", "500"),
	({ output }) =>
		Effect.forEach(
			Arr.filter(lines(output), (line) => line !== ""),
			(line) =>
				Effect.flatMap(parseJson(line), (row) =>
					Schema.decodeUnknownEffect(
						Schema.Struct({ message: Schema.optionalKey(Schema.String) })
					)(row).pipe(Effect.orDie)
				)
		).pipe(
			Effect.map(
				Arr.flatMap(({ message }) => (message === undefined ? [] : [message]))
			)
		)
);

/** Waits until `check` holds, for up to 10 seconds. */
const eventually = <E = never, R = never>(
	what: string,
	check: Effect.Effect<boolean, E, R> | (() => boolean)
) =>
	Effect.gen(function* () {
		const holds = typeof check === "function" ? Effect.sync(check) : check;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (yield* holds) {
				return;
			}
			yield* Effect.promise(() => Bun.sleep(50));
		}
		return yield* Effect.die(`Timed out waiting for ${what}.`);
	});

/** Long enough for a notification and the pass it runs to land. */
const settle = Effect.promise(() => Bun.sleep(1500));

/**
 * Makes mx sync count as registered to start at sign-in, as mx install leaves it: on macOS that is the LaunchAgent's
 * plist; elsewhere the fake programs that ask already answer that it is.
 */
const registerSync = Effect.gen(function* () {
	if (process.platform !== "darwin") {
		return;
	}
	const fs = yield* FileSystem.FileSystem;
	const agents = join(second.home, "Library", "LaunchAgents");
	yield* fs.makeDirectory(agents, { recursive: true });
	yield* fs.writeFileString(
		join(agents, "io.github.pixelhabits.mx.sync.plist"),
		""
	);
});

const lastSyncLine =
	/^Last sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, \d+ (s|min) ago$/u;
const modeLine = /^Mode: (starting|push|poll)$/u;

describe("mx sync with several accounts", () => {
	test("mx login --account that adds an account next to others syncs none of its mail: it restarts mx sync, which copies the mail in the background, and mx status shows how far that first sync has got", () =>
		Effect.gen(function* () {
			microsoft.signingIn = sam;
			yield* second.cli(
				"login",
				"--account",
				"work",
				"--client-id",
				clientId,
				"--tenant",
				tenant
			);
			yield* registerSync;
			microsoft.deliver({
				body: "You are next on the list for a plot.",
				conversationId: "pat-conversation-allotment",
				from: rosa,
				parentFolderId: pat.resolve("inbox"),
				received: "2026-10-05T08:00:00Z",
				subject: "Allotment waiting list",
			});
			microsoft.deliver({
				body: "The spring catalogue is in the post.",
				conversationId: "pat-conversation-seeds",
				from: rosa,
				parentFolderId: pat.resolve("archive"),
				received: "2026-10-04T08:00:00Z",
				subject: "Seed catalogue",
			});
			microsoft.signingIn = pat;
			const asked = microsoft.graphRequests().length;
			const { output } = yield* second.cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			expect(
				Arr.filter(microsoft.graphRequests().slice(asked), ({ url }) =>
					pipe(url.pathname, Str.endsWith("/messages/delta"))
				)
			).toEqual([]);
			expect(lines(output).slice(-2)).toEqual([
				"Restarted mx sync.",
				"Added personal. mx sync copies its mail in the background. Run mx status to see how far it has got.",
			]);
			// The mx sync that mx login restarted, whose first sync of Pat's mailbox waits in its Inbox.
			const inbox = pat.resolve("inbox");
			microsoft.hold(inbox);
			const service = yield* Effect.forkChild(second.cli("sync"));
			/** How many of the account's folders in the store have a delta link; none while mx sync creates the store. */
			const linked = (account: number) =>
				Effect.try(
					() =>
						Arr.filter(
							foldersOf(account),
							({ delta_link }) => delta_link !== null
						).length
				).pipe(Effect.orElseSucceed(() => 0));
			yield* eventually(
				"every folder of Pat's but Inbox synced",
				Effect.map(linked(2), (count) => count === pat.folders.size - 1)
			);
			const report = lines((yield* second.run("status")).output);
			const personal = report.indexOf("Account personal: pat@example.org");
			expect(report.slice(personal, personal + 3)).toEqual([
				"Account personal: pat@example.org",
				"Last sync: never",
				`First sync: ${pat.folders.size - 1} of ${pat.folders.size} folders done`,
			]);
			microsoft.release(inbox);
			yield* eventually(
				"the first sync of both accounts",
				Effect.map(
					Effect.all([linked(1), linked(2)]),
					([samFolders, patFolders]) =>
						samFolders === sam.folders.size && patFolders === pat.folders.size
				)
			);
			yield* Fiber.interrupt(service);
			expect(mailOf(2)).toEqual(mailIn(pat));
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release(pat.resolve("inbox"));
				})
			)
		));

	test("mx sync --once syncs every account into the one store, each mailbox's folders and mail under its own account, and says how each went", () =>
		Effect.gen(function* () {
			const { output } = yield* second.cli("sync", "--once");
			expect(lines(output)).toEqual([
				`work: Synced ${sam.folders.size} folders: 0 messages saved, 0 removed.`,
				`personal: Synced ${pat.folders.size} folders: 0 messages saved, 0 removed.`,
			]);
			expect(Arr.map(foldersOf(1), ({ id }) => id)).toEqual(folderIdsIn(sam));
			expect(Arr.map(foldersOf(2), ({ id }) => id)).toEqual(folderIdsIn(pat));
			expect(mailOf(1)).toEqual(mailIn(sam));
			expect(mailOf(2)).toEqual(mailIn(pat));
		}));

	test("one account's folder listing drops that account's deleted folder with its mail, and keeps every folder, delta link and message of the other account", () =>
		Effect.gen(function* () {
			const before = accountRows(2);
			microsoft.removeFolder(microsoft.folderId("Projects"));
			// Pat's pass waits in its Inbox's delta round, so nothing Pat's own pass does restores what Sam's listing dropped.
			const inbox = pat.resolve("inbox");
			const asked = deltaRequests(inbox);
			microsoft.hold(inbox, { answered: true });
			const pass = yield* Effect.forkChild(second.cli("sync", "--once"));
			yield* eventually(
				"Pat's Inbox delta round",
				() => deltaRequests(inbox) > asked
			);
			expect(Arr.map(foldersOf(1), ({ id }) => id)).toEqual(folderIdsIn(sam));
			expect(mailOf(1)).toEqual(mailIn(sam));
			expect(accountRows(2)).toEqual(before);
			microsoft.release(inbox);
			yield* Fiber.join(pass);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release(pat.resolve("inbox"));
				})
			)
		));

	test("one account's check against Graph never removes the other account's mail", () =>
		Effect.gen(function* () {
			const before = accountRows(2);
			// Pat's check waits on the ids of Pat's Inbox, so nothing Pat's own check does restores what Sam's check removed.
			const inbox = pat.resolve("inbox");
			const samChecks = Effect.map(
				syncLines,
				Arr.filter(Str.startsWith("work: Reconciled "))
			);
			const checked = (yield* samChecks).length;
			microsoft.hold(inbox, { ids: true });
			const service = yield* Effect.forkChild(second.cli("sync"));
			yield* eventually(
				"Sam's check against Graph",
				Effect.map(samChecks, (checks) => checks.length > checked)
			);
			expect((yield* samChecks).slice(checked)).toEqual([
				`work: Reconciled ${sam.folders.size} folders: 0 added, 0 refiled, 0 removed.`,
			]);
			expect(accountRows(2)).toEqual(before);
			microsoft.release(inbox, { ids: true });
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release(pat.resolve("inbox"), { ids: true });
				})
			)
		));

	test("a change notification for one account's Inbox runs a delta round of that Inbox alone, and no pass of the other account", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(join(home, "bin"), { recursive: true });
			yield* fs.writeFileString(cloudflared, "");
			services.push(yield* Effect.forkDetach(cliOn(pushing)("sync")));
			yield* eventually(
				"push for both accounts",
				() =>
					Arr.every(
						[sam, pat],
						(mailbox) => tunnelSubscriptions(mailbox).length === 2
					) &&
					Arr.every([1, 2], (account) =>
						Option.exists(followed(account), ({ mode }) => mode === "push")
					)
			);
			const inbox = pat.resolve("inbox");
			/** The delta requests of every folder but Pat's Inbox, in both mailboxes. */
			const others = () =>
				Arr.map(
					Arr.filter(
						[...folderIdsIn(sam), ...folderIdsIn(pat)],
						(folder) => folder !== inbox
					),
					(folder) => [folder, deltaRequests(folder)] as const
				);
			const before = others();
			const inboxBefore = deltaRequests(inbox);
			yield* Effect.promise(() => microsoft.receive("Allotment rota", pat));
			yield* eventually("the pushed message in Pat's account", () =>
				Arr.some(mailOf(2), ({ subject }) => subject === "Allotment rota")
			);
			yield* settle;
			expect(others()).toEqual(before);
			expect(deltaRequests(inbox)).toBeGreaterThan(inboxBefore);
		}));

	test("stopping mx sync deletes the subscriptions of every account", () =>
		Effect.gen(function* () {
			expect(
				Arr.map([sam, pat], (mailbox) => tunnelSubscriptions(mailbox).length)
			).toEqual([2, 2]);
			yield* Effect.forEach(services.splice(0), Fiber.interrupt, {
				discard: true,
			});
			expect(
				Arr.map([sam, pat], (mailbox) => [...mailbox.subscriptions.byId.keys()])
			).toEqual([[], []]);
		}));

	test("a refused sign-in stops only its own account: mx sync goes on syncing the other account, and mx status names the account that stopped", () =>
		Effect.gen(function* () {
			pat.refuseRefresh = true;
			const service = yield* Effect.forkChild(cliOn(pushing)("sync"));
			const expired = "Sign-in expired. Run mx login --account personal.";
			yield* eventually("Pat's account stopped", () =>
				Option.exists(followed(2), (row) => row.last_error === expired)
			);
			yield* eventually("push for Sam's account", () =>
				Option.exists(followed(1), ({ mode }) => mode === "push")
			);
			yield* Effect.promise(() => microsoft.receive("Compost delivery", sam));
			yield* eventually("the pushed message in Sam's account", () =>
				Arr.some(mailOf(1), ({ subject }) => subject === "Compost delivery")
			);
			expect(service.pollUnsafe()).toBeUndefined();
			const { errors, exit, output } = yield* second.run("status");
			expect(Exit.isFailure(exit)).toBe(true);
			expect(errors).toBe(`mx: personal: mx sync reports an error: ${expired}`);
			const report = lines(output);
			expect(
				report.slice(report.indexOf("Account work: sam@example.test"))
			).toEqual([
				"Account work: sam@example.test",
				expect.stringMatching(lastSyncLine),
				"Mode: push",
				"Sign-in: saved",
				`Client id: ${clientId}`,
				`Tenant: ${tenant}`,
				"Last error: none",
				"Account personal: pat@example.org",
				expect.stringMatching(lastSyncLine),
				expect.stringMatching(modeLine),
				"Sign-in: saved",
				`Client id: ${otherClientId}`,
				"Tenant: example.org",
				`Last error: ${expired}`,
			]);
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					pat.refuseRefresh = false;
				})
			)
		));

	test("mx sync --once syncs every account when the first account's sign-in is refused, names that account, and fails", () =>
		Effect.gen(function* () {
			sam.refuseRefresh = true;
			microsoft.deliver({
				body: "The bean poles go up on Saturday.",
				conversationId: "pat-conversation-bean-poles",
				from: rosa,
				parentFolderId: pat.resolve("inbox"),
				received: "2026-10-06T08:00:00Z",
				subject: "Bean poles",
			});
			const { errors, exit, output } = yield* second.run("sync", "--once");
			expect(Exit.isFailure(exit)).toBe(true);
			expect(lines(output)).toEqual([
				`personal: Synced ${pat.folders.size} folders: 1 messages saved, 0 removed.`,
			]);
			expect(errors).toBe(
				"mx: work: Sign-in expired. Run mx login --account work."
			);
			expect(mailOf(2)).toEqual(mailIn(pat));
			expect(
				Arr.some(mailOf(2), ({ subject }) => subject === "Bean poles")
			).toBe(true);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					sam.refuseRefresh = false;
				})
			)
		));
});

/**
 * An mx mcp that an agent starts now on the second machine, so it reads config.json as it is now, with a client on its
 * stdio; the scope stops it.
 */
const startAgent = Effect.gen(function* () {
	const { client, stdio } = yield* connect();
	yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
		Effect.provide(stdio),
		// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
		Effect.provide(second.platform, { local: true }),
		Effect.forkScoped
	);
	return client;
});

/**
 * Runs `body` with its tool calls going to an mx mcp started as it begins, since the file's first mx mcp runs on the
 * first machine.
 */
const withAgent = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	body.pipe(Effect.provideServiceEffect(McpClient, startAgent), Effect.scoped);

/** The lines of a read tool's answer without the warnings before them, which depend on how long ago mx sync last ran. */
const answerLines = (text: string) =>
	Arr.filter(lines(text), (line) => !pipe(line, Str.startsWith("⚠ ")));

/** The local id of the one stored message with the subject. */
const localIdOf = (subject: string) =>
	Option.getOrThrow(
		Arr.head(
			rowsOf<{ readonly id: number }>(
				"SELECT id FROM messages WHERE subject = ?",
				subject
			)
		)
	).id;

/** The message Graph holds in `mailbox` with the subject. */
const heldIn = (mailbox: FakeMailbox, subject: string) =>
	Option.getOrThrow(
		Arr.findFirst(
			[...mailbox.messages.values()],
			(message) => message.subject === subject
		)
	);

/** The subjects of the messages Graph holds in the well-known folder of `mailbox`. */
const subjectsIn = (mailbox: FakeMailbox, folder: "drafts" | "sentitems") =>
	Arr.map(mailbox.inFolder(mailbox.resolve(folder)), ({ subject }) => subject);

/** The Graph requests made since the `from`th, whose path ends with `ending`. */
const graphRequestsSince = (from: number, ending: string) =>
	Arr.filter(microsoft.graphRequests().slice(from), ({ url }) =>
		pipe(url.pathname, Str.endsWith(ending))
	);

/** The search lines of the seed mail in each account. */
const swap =
	/^#\d+ \[work\] .* Inbox \| Rosa Example <rosa@example\.com> \| Seed swap \| unread$/u;
const catalogue =
	/^#\d+ \[personal\] .* Archive \| Rosa Example <rosa@example\.com> \| Seed catalogue \| unread$/u;
/** The listing lines of the reply drafted in Pat's account and the new message drafted in Sam's. */
const replyDraftLine =
	/^#\d+ \[personal\] .* Drafts \| to Rosa Example <rosa@example\.com> \| RE: Allotment waiting list \| draft$/u;
const newDraftLine =
	/^#\d+ \[work\] .* Drafts \| to rosa@example\.com \| Plot fees \| draft$/u;

describe("tools across accounts", () => {
	test("a tool call on a message of the second account goes to Graph with that account's access token, and the message stays in the store", () =>
		Effect.gen(function* () {
			yield* second.cli("sync", "--once");
			const rota = heldIn(pat, "Allotment rota");
			const before = microsoft.graphRequests().length;
			const answer = yield* tool("message", {
				full: true,
				id: localIdOf("Allotment rota"),
			});
			expect(answer).toContain("Allotment rota, in the body.");
			const asked = Arr.filter(
				microsoft.graphRequests().slice(before),
				({ url }) => pipe(url.pathname, Str.includes(rota.id))
			);
			expect(Arr.isReadonlyArrayNonEmpty(asked)).toBe(true);
			expect(Arr.map(asked, ({ authorization }) => authorization)).toEqual(
				Arr.map(asked, () => `Bearer ${pat.accessToken}`)
			);
			expect(mailOf(2)).toEqual(mailIn(pat));
		}).pipe(withAgent));

	test("a message id names its account: thread, message and update act on the mail of either account, and their answers name it", () =>
		Effect.gen(function* () {
			const compost = localIdOf("Compost delivery");
			const waiting = localIdOf("Allotment waiting list");
			expect(answerLines(yield* tool("thread", { id: waiting }))[0]).toBe(
				"[personal] Allotment waiting list, 1 messages"
			);
			expect(
				answerLines(yield* tool("message", { id: compost }))[0]
			).toStartWith(`#${compost} [work] `);
			expect(
				answerLines(yield* tool("message", { full: true, id: waiting }))[0]
			).toStartWith(`#${waiting} [personal] `);
			const updated = lines(
				yield* tool("update", { ids: [compost, waiting], read: true })
			);
			expect(updated).toEqual([
				expect.stringMatching(
					new RegExp(`^#${compost} \\[work\\] .*Compost delivery$`)
				),
				expect.stringMatching(
					new RegExp(`^#${waiting} \\[personal\\] .*Allotment waiting list$`)
				),
			]);
			expect(heldIn(sam, "Compost delivery").isRead).toBe(true);
			expect(heldIn(pat, "Allotment waiting list").isRead).toBe(true);
		}).pipe(withAgent));

	test("with two accounts folder needs account, and update refuses to move a message to a folder of the other account and sends Graph no move", () =>
		Effect.gen(function* () {
			expect(yield* call("folder", { create: "Allotment" })).toMatchObject({
				isError: true,
				text: "folder needs account with several accounts: work or personal.",
			});
			expect(
				yield* tool("folder", { account: "personal", create: "Allotment" })
			).toBe("Created personal: Allotment.");
			const compost = heldIn(sam, "Compost delivery");
			const before = microsoft.graphRequests().length;
			expect(
				yield* call("update", {
					ids: [localIdOf("Compost delivery")],
					move_to: "Allotment",
				})
			).toMatchObject({
				isError: true,
				text: "Allotment is in personal; mx moves mail only within an account.",
			});
			expect(graphRequestsSince(before, "/move")).toEqual([]);
			expect(compost.parentFolderId).toBe(sam.resolve("inbox"));
		}).pipe(withAgent));

	test("a reply comes from the account of the message it answers, and draft refuses another account", () =>
		Effect.gen(function* () {
			const waiting = localIdOf("Allotment waiting list");
			const samDrafts = subjectsIn(sam, "drafts");
			expect(
				yield* call("draft", {
					account: "work",
					body: "Yes please.",
					kind: "reply",
					message: waiting,
				})
			).toMatchObject({
				isError: true,
				text: `#${waiting} is in personal; a reply comes from personal.`,
			});
			const drafted = yield* tool("draft", {
				body: "Yes please.",
				kind: "reply",
				message: waiting,
			});
			expect(drafted).toMatch(replyDraftLine);
			expect(subjectsIn(pat, "drafts")).toContain("RE: Allotment waiting list");
			expect(subjectsIn(sam, "drafts")).toEqual(samDrafts);
		}).pipe(withAgent));

	test("with two accounts a new message without account is refused, and with account it is drafted in that account", () =>
		Effect.gen(function* () {
			const drafts = [subjectsIn(sam, "drafts"), subjectsIn(pat, "drafts")];
			const fields = {
				body: "What are the plot fees this year?",
				kind: "new",
				subject: "Plot fees",
				to: [rosa.address],
			};
			expect(yield* call("draft", fields)).toMatchObject({
				isError: true,
				text: "kind new needs account with several accounts: work or personal.",
			});
			expect([subjectsIn(sam, "drafts"), subjectsIn(pat, "drafts")]).toEqual(
				drafts
			);
			expect(yield* tool("draft", { ...fields, account: "work" })).toMatch(
				newDraftLine
			);
			expect(subjectsIn(sam, "drafts")).toContain("Plot fees");
		}).pipe(withAgent));

	test("send needs from with two accounts, and a from other than the draft's account or the answered message's sends nothing", () =>
		Effect.gen(function* () {
			const reply = localIdOf("RE: Allotment waiting list");
			const fields = {
				bcc: [],
				cc: [],
				draft: reply,
				subject: "RE: Allotment waiting list",
				to: [rosa.address],
			};
			const sent = [subjectsIn(sam, "sentitems"), subjectsIn(pat, "sentitems")];
			const before = microsoft.graphRequests().length;
			const refusals = yield* Effect.forEach(
				[
					{ ...fields, from: "work" },
					fields,
					{
						body: "Count me in.",
						from: "work",
						kind: "reply",
						message: localIdOf("Allotment waiting list"),
					},
				],
				(args) => call("send", args)
			);
			expect(refusals).toMatchObject([
				{
					isError: true,
					text: `Nothing was sent: #${reply} is a draft in personal.`,
				},
				{
					isError: true,
					text: "Nothing was sent: send needs from with several accounts: work or personal.",
				},
				{
					isError: true,
					text: `Nothing was sent: #${localIdOf("Allotment waiting list")} is in personal; a reply comes from personal.`,
				},
			]);
			expect([
				subjectsIn(sam, "sentitems"),
				subjectsIn(pat, "sentitems"),
			]).toEqual(sent);
			expect([
				...graphRequestsSince(before, "/send"),
				...graphRequestsSince(before, "/sendMail"),
				...graphRequestsSince(before, "/reply"),
			]).toEqual([]);
			expect(yield* tool("send", { ...fields, from: "personal" })).toBe(
				`Sent #${reply} from personal to ${rosa.address}: RE: Allotment waiting list`
			);
			expect(subjectsIn(pat, "sentitems")).toContain(
				"RE: Allotment waiting list"
			);
		}).pipe(withAgent));

	test("search and query span both accounts, show each line's account and filter by account, and an unknown account is refused", () =>
		Effect.gen(function* () {
			microsoft.deliver({
				body: "Swap my tomato seed for your bean seed?",
				conversationId: "sam-conversation-seed-swap",
				from: rosa,
				parentFolderId: sam.resolve("inbox"),
				received: "2026-10-07T08:00:00Z",
				subject: "Seed swap",
			});
			yield* second.cli("sync", "--once");
			const both = answerLines(yield* tool("search", { query: "seed" }));
			expect(both).toHaveLength(2);
			expect(both).toEqual(
				expect.arrayContaining([
					expect.stringMatching(swap),
					expect.stringMatching(catalogue),
				])
			);
			expect(
				answerLines(
					yield* tool("search", { account: "personal", query: "seed" })
				)
			).toEqual([expect.stringMatching(catalogue)]);
			expect(
				answerLines(yield* tool("search", { folder: "Inbox", query: "seed" }))
			).toEqual([expect.stringMatching(swap)]);
			const seeds =
				"SELECT account, subject FROM mail WHERE subject LIKE 'Seed%' ORDER BY account DESC";
			expect(answerLines(yield* tool("query", { sql: seeds }))).toEqual([
				"account\tsubject",
				"work\tSeed swap",
				"personal\tSeed catalogue",
			]);
			expect(
				answerLines(yield* tool("query", { account: "personal", sql: seeds }))
			).toEqual(["account\tsubject", "personal\tSeed catalogue"]);
			expect(
				answerLines(
					yield* tool("query", {
						account: "work",
						sql: "SELECT account FROM folders UNION SELECT account FROM conversations",
					})
				)
			).toEqual(["account", "work"]);
			const refusals = yield* Effect.forEach(
				[
					call("search", { account: "garden" }),
					call("query", { account: "garden", sql: seeds }),
				],
				(refused) =>
					Effect.map(refused, ({ isError, text }) => ({
						isError,
						lines: answerLines(text),
					}))
			);
			expect(refusals).toEqual(
				Arr.replicate(
					{
						isError: true,
						lines: ["No account garden. The accounts are work and personal."],
					},
					2
				)
			);
		}).pipe(withAgent));

	test("with two accounts a read tool warns about each account by its alias, and a refused sign-in names the account to sign in to again", () =>
		Effect.gen(function* () {
			pat.refuseRefresh = true;
			const service = yield* Effect.forkChild(second.cli("sync"));
			const expired = "Sign-in expired. Run mx login --account personal.";
			yield* eventually("Pat's account stopped", () =>
				Option.exists(followed(2), (row) => row.last_error === expired)
			);
			yield* eventually("a pass of Sam's account", () =>
				Option.exists(followed(1), (row) => row.mode !== "starting")
			);
			const found = lines(yield* tool("search", { query: "seed" }));
			expect(found[0]).toBe(`⚠ personal: ${expired}`);
			expect(found.slice(1)).toHaveLength(2);
			const refused = yield* call("message", {
				full: true,
				id: localIdOf("Seed catalogue"),
			});
			expect(refused.isError).toBe(true);
			expect(lines(refused.text).at(-1)).toBe(
				"Microsoft refused the saved sign-in (invalid_grant). Run mx login --account personal."
			);
			yield* Fiber.interrupt(service);
		}).pipe(
			withAgent,
			Effect.ensuring(
				Effect.sync(() => {
					pat.refuseRefresh = false;
				})
			)
		));

	test("with two accounts mx mcp's instructions name each account and the rules, and triage and interview take the accounts in turn; with one account the instructions are as before", () =>
		Effect.gen(function* () {
			const instructions = Effect.flatMap(startAgent, (agent) =>
				Effect.map(
					agent.request("server/discover"),
					(found) => (found as { readonly instructions: string }).instructions
				)
			);
			const block = `The user has several mail accounts:
- work: sam@example.test
- personal: pat@example.org
Each message id belongs to one account, and tools act in that account. A reply, reply-all or forward always comes from the account of the message it answers. For a new message, name the account in draft, and ask the user which one if they have not said. send needs from, the alias of the account the draft is in. Mail never moves between accounts: move_to and the folder tools only see the message's own account.`;
			const several = yield* instructions;
			expect(several).toContain(`\n\n${block}\n\n`);
			const client = yield* startAgent;
			expect(yield* client.prompt("triage", {})).toContain(
				"Report each account under its own heading."
			);
			expect(yield* client.prompt("interview", {})).toContain(
				"Ask what each account is for."
			);
			const saved = yield* readJson(second.configFile);
			yield* writeJson(second.configFile, { accounts: [samAccount("work")] });
			const one = yield* instructions.pipe(
				Effect.ensuring(Effect.orDie(writeJson(second.configFile, saved)))
			);
			expect(one).toStartWith(
				"mx is a local copy of the user's Microsoft 365 mailbox, kept current by mx sync."
			);
			expect(one).toBe(pipe(several, Str.replace(`${block}\n\n`, "")));
		}).pipe(Effect.scoped));

	test("mx logout --account removes that account's copy of the mail, its subscriptions, its sign-in and last its entry in config.json, then restarts mx sync, leaves the other account as it was and the mailbox in Microsoft 365 untouched, and refuses the last account", () =>
		Effect.gen(function* () {
			const noTerminal = yield* second.run("logout", "--account", "personal");
			expect(Exit.isFailure(noTerminal.exit)).toBe(true);
			expect(noTerminal.errors).toContain(
				"mx can't ask you to confirm the logout here. Run mx logout --account personal --yes."
			);
			expect(Arr.isReadonlyArrayNonEmpty(mailOf(2))).toBe(true);
			const work = accountRows(1);
			const held = [...pat.messages.keys()];
			/** A subscription of the running mx sync in `mailbox`. */
			const subscribe = (mailbox: FakeMailbox) =>
				mailbox.subscriptions.seed({
					changeType: "created,updated,deleted",
					clientState: "this run",
					expirationDateTime: "2026-10-09T00:00:00Z",
					lifecycleNotificationUrl: "https://tunnel-9.trycloudflare.com/graph",
					notificationUrl: "https://tunnel-9.trycloudflare.com/graph",
					resource: "me/mailFolders('inbox')/messages",
				});
			const samSubscription = subscribe(sam);
			subscribe(pat);
			let atRestart:
				| { readonly listed: boolean; readonly signedIn: boolean }
				| undefined;
			processes.onSpawn = () => {
				atRestart ??= {
					listed: pipe(
						readFileSync(second.configFile, "utf8"),
						Str.includes('"personal"')
					),
					signedIn: secrets.entries.has("mx/refresh-token-2"),
				};
			};
			const { output } = yield* second
				.cli("logout", "--account", "personal", "--yes")
				.pipe(
					Effect.ensuring(
						Effect.sync(() => {
							processes.onSpawn = undefined;
						})
					)
				);
			expect(lines(output)).toContain(
				"Removed personal (pat@example.org): its sign-in and the copy of its mail. Its mailbox in Microsoft 365 is unchanged. Restart your agents so they see the change."
			);
			expect(atRestart).toEqual({ listed: false, signedIn: false });
			expect(tunnelSubscriptions(pat)).toEqual([]);
			expect(Arr.map(tunnelSubscriptions(sam), ({ id }) => id)).toEqual([
				samSubscription,
			]);
			expect(yield* readJson(second.configFile)).toEqual({
				accounts: [samAccount("work")],
			});
			expect(secrets.entries.has("mx/refresh-token-2")).toBe(false);
			expect(secrets.entries.has("mx/refresh-token")).toBe(true);
			expect(accountRows(2)).toEqual({ folders: [], mail: [] });
			expect(followed(2)).toEqual(Option.none());
			expect(accountRows(1)).toEqual(work);
			expect([...pat.messages.keys()]).toEqual(held);
			const last = yield* Effect.flip(
				second.cli("logout", "--account", "work", "--yes")
			);
			expect(last.message).toBe(
				"work is the only account. To remove it with the rest of mx, run mx uninstall."
			);
			expect(yield* readJson(second.configFile)).toEqual({
				accounts: [samAccount("work")],
			});
		}));

	test("mx sync drops, as it starts, the mail of an account that config.json does not name, as an mx sync that ran on through a logout can leave", () =>
		Effect.gen(function* () {
			microsoft.signingIn = pat;
			yield* second.cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			yield* second.cli("sync", "--once");
			expect(mailOf(2)).toEqual(mailIn(pat));
			const work = foldersOf(1);
			yield* writeJson(second.configFile, { accounts: [samAccount("work")] });
			const service = yield* Effect.forkChild(second.cli("sync"));
			yield* eventually(
				"the dropped account's folders",
				() => foldersOf(2).length === 0
			);
			expect(mailOf(2)).toEqual([]);
			expect(Arr.map(foldersOf(1), ({ id }) => id)).toEqual(
				Arr.map(work, ({ id }) => id)
			);
			yield* Fiber.interrupt(service);
		}));

	test("an mx logout that stops partway, here as the secret store goes down while the user confirms, leaves the account in config.json, and mx logout --account run again removes the rest of it", () =>
		Effect.gen(function* () {
			microsoft.signingIn = pat;
			yield* second.cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			const { system } = terminalWith(
				["y"],
				() => {
					secrets.machine = "broken";
				},
				second.platform
			);
			const { exit } = yield* onTerminal(
				runOn(system)("logout", "--account", "personal")
			);
			secrets.machine = "store";
			expect(Exit.isFailure(exit)).toBe(true);
			expect(accountRows(2)).toEqual({ folders: [], mail: [] });
			expect(secrets.entries.has("mx/refresh-token-2")).toBe(true);
			expect(yield* readJson(second.configFile)).toEqual({
				accounts: [samAccount("work"), patAccount],
			});
			const { output } = yield* second.cli(
				"logout",
				"--account",
				"personal",
				"--yes"
			);
			expect(lines(output)).toContain(
				"Removed personal (pat@example.org): its sign-in and the copy of its mail. Its mailbox in Microsoft 365 is unchanged. Restart your agents so they see the change."
			);
			expect(secrets.entries.has("mx/refresh-token-2")).toBe(false);
			expect(yield* readJson(second.configFile)).toEqual({
				accounts: [samAccount("work")],
			});
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					secrets.machine = "store";
				})
			)
		));

	test("after mx logout removes account 1, mx install signs in to no account and syncs none again, and the other account goes on syncing", () =>
		Effect.gen(function* () {
			microsoft.signingIn = pat;
			yield* second.cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			yield* second.cli("sync", "--once");
			yield* second.cli("logout", "--account", "work", "--yes");
			yield* writeJson(join(second.home, ".claude.json"), {});
			const before = microsoft.received.length;
			const { output } = yield* second.cli("install", "--agent", "claude-code");
			expect(microsoft.received.slice(before)).toEqual([]);
			expect(lines(output)).toContain("Started mx sync.");
			microsoft.deliver({
				body: "The water butts are full again.",
				conversationId: "pat-conversation-water",
				from: rosa,
				parentFolderId: pat.resolve("inbox"),
				received: "2026-10-07T08:00:00Z",
				subject: "Water butts",
			});
			const synced = yield* second.cli("sync", "--once");
			expect(lines(synced.output)).toEqual([
				`Synced ${pat.folders.size} folders: 1 messages saved, 0 removed.`,
			]);
			expect(mailOf(2)).toEqual(mailIn(pat));
		}));
});

/** A machine for each mx install below, where mx has no account yet. */
const third = await machine.runPromise(machineAt(join(home, "third")));
const fourth = await machine.runPromise(machineAt(join(home, "fourth")));

const addAnother = "Add another Microsoft 365 account?";

/**
 * `base` on a terminal where the user answers each of `answers` in turn: once mx draws a frame that shows the answer's
 * prompt, `asked` runs and the user presses its keys. `frames` keeps what mx drew.
 */
const answering = (
	answers: readonly {
		readonly keys: readonly string[];
		readonly prompt: string;
		readonly asked?: () => void;
	}[],
	base: Platform
) => {
	const frames: string[] = [];
	let answered = 0;
	const terminal = Layer.effect(
		Terminal.Terminal,
		Effect.map(Queue.make<Terminal.UserInput, Cause.Done>(), (input) =>
			Terminal.make({
				columns: Effect.succeed(80),
				display: (text) =>
					Effect.sync(() => {
						frames.push(text);
						const next = answers[answered];
						if (next !== undefined && pipe(text, Str.includes(next.prompt))) {
							answered += 1;
							next.asked?.();
							Queue.offerAllUnsafe(input, Arr.map(next.keys, keyPress));
						}
					}),
				readInput: Effect.succeed(input),
				readLine: Effect.die("mx reads no lines from the terminal."),
				rows: Effect.succeed(24),
			})
		)
	);
	return { frames, system: Layer.merge(base, terminal) };
};

/** Whether the request asks for a delta page of a folder of `mailbox`. */
const isDeltaOf =
	(mailbox: FakeMailbox) =>
	({ url }: { readonly url: URL }) =>
		Arr.some(folderIdsIn(mailbox), (folder) =>
			pipe(url.pathname, Str.endsWith(`/${folder}/messages/delta`))
		);

describe("mx install with several accounts", () => {
	test("on a terminal, mx install asks after each sign-in whether to add another account and signs in each one added before it reads any mail, then syncs every account in the foreground, each on a line of its own", () =>
		Effect.gen(function* () {
			yield* (yield* FileSystem.FileSystem).makeDirectory(third.home, {
				recursive: true,
			});
			yield* writeJson(join(third.home, ".claude.json"), {});
			microsoft.signingIn = sam;
			const { frames, system } = answering(
				[
					{
						keys: [...typing("work"), "return"],
						prompt: "Alias for the new account",
					},
					{
						asked: () => {
							microsoft.signingIn = pat;
						},
						keys: ["y"],
						prompt: addAnother,
					},
					{ keys: [...typing(otherClientId), "return"], prompt: "Client id" },
					{ keys: [...typing("example.org"), "return"], prompt: "Tenant" },
					{
						keys: [...typing("personal"), "return"],
						prompt: "Alias for the new account",
					},
					{ keys: ["return"], prompt: addAnother },
				],
				third.platform
			);
			const before = microsoft.received.length;
			const { output } = yield* onTerminal(
				cliOn(system)(
					"install",
					"--agent",
					"claude-code",
					"--client-id",
					clientId,
					"--tenant",
					tenant
				)
			);
			const requests = microsoft.received.slice(before);
			const lastSignIn = Arr.findLastIndex(
				requests,
				({ body, url }) =>
					url.hostname === loginHost &&
					new URLSearchParams(body).get("grant_type") ===
						"urn:ietf:params:oauth:grant-type:device_code"
			);
			const firstMail = Arr.findFirstIndex(
				requests,
				({ url }) => url.hostname === "graph.microsoft.com"
			);
			expect(
				Arr.filter(requests, ({ url }) =>
					pipe(url.pathname, Str.endsWith("/devicecode"))
				)
			).toHaveLength(2);
			expect(Option.getOrThrow(firstMail)).toBeGreaterThan(
				Option.getOrThrow(lastSignIn)
			);
			expect(yield* readJson(third.configFile)).toEqual({
				accounts: [samAccount("work"), patAccount],
			});
			expect(frames.slice(-2)).toEqual([
				`\u001b[1A\rwork: Synced ${sam.folders.size} folders: ${sam.messages.size} messages saved, 0 removed.\u001b[K\n\rpersonal: Synced ${pat.folders.size} folders: ${pat.messages.size} messages saved, 0 removed.\u001b[K`,
				"\n",
			]);
			expect(lines(output)).toContain("Started mx sync.");
		}));

	test("mx install runs the first syncs of the accounts at once, and without a terminal prints each account's lines after its alias", () =>
		Effect.gen(function* () {
			microsoft.signingIn = sam;
			yield* fourth.cli("login", "--client-id", clientId, "--tenant", tenant);
			microsoft.signingIn = pat;
			yield* fourth.cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
			);
			yield* writeJson(join(fourth.home, ".claude.json"), {});
			const inbox = sam.resolve("inbox");
			const asked = microsoft.graphRequests().length;
			const ended = microsoft.roundsEnded.length;
			// Sam's first sync waits in its Inbox, so it cannot finish before Pat's starts unless both run at once.
			microsoft.hold(inbox);
			const install = yield* Effect.forkChild(
				fourth.cli("install", "--agent", "claude-code")
			);
			yield* eventually("the first delta request of Pat's first sync", () =>
				Arr.some(microsoft.graphRequests().slice(asked), isDeltaOf(pat))
			);
			expect(microsoft.roundsEnded.slice(ended)).not.toContain(inbox);
			microsoft.release(inbox);
			const { output } = yield* Fiber.join(install);
			expect(lines(output)).toEqual(
				expect.arrayContaining([
					`contoso: Syncing ${sam.folders.size} folders: 0 of ${sam.messages.size} messages`,
					`personal: Syncing ${pat.folders.size} folders: 0 of ${pat.messages.size} messages`,
					`contoso: Synced ${sam.folders.size} folders: ${sam.messages.size} messages saved, 0 removed.`,
					`personal: Synced ${pat.folders.size} folders: ${pat.messages.size} messages saved, 0 removed.`,
				])
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release(sam.resolve("inbox"));
				})
			)
		));
});
