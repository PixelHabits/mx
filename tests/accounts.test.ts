import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
	Array as Arr,
	type Cause,
	ConfigProvider,
	Context,
	Duration,
	Effect,
	Exit,
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
import { FakeMicrosoft, loginHost } from "./fake-microsoft.ts";
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

/** The environment of every mx process here: its folders under the test home, and no client id or tenant. */
const environment = {
	APPDATA: join(home, "AppData", "Roaming"),
	HOME: home,
	LOCALAPPDATA: join(home, "AppData", "Local"),
	PATH: join(home, "path"),
	USERPROFILE: home,
	XDG_CACHE_HOME: join(home, "cache"),
	XDG_CONFIG_HOME: join(home, "config"),
	XDG_DATA_HOME: join(home, "data"),
	XDG_STATE_HOME: join(home, "state"),
};
const config = ConfigProvider.layer(ConfigProvider.fromUnknown(environment));
const { configFile, database } = await machine.runPromise(
	// @effect-diagnostics-next-line strictEffectProvide:off - where mx keeps its files on this machine.
	Effect.provide(Paths.make, config)
);

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
 * What every mx process runs on: Microsoft, Bun with faked child processes, a console that keeps its lines, and the
 * terminal's capabilities from the TTY state of stdin and stdout.
 */
const platform = Layer.mergeAll(
	microsoft.layer,
	BunServices.layer,
	processes.layer(environment),
	TestConsole.layer,
	config,
	TerminalCapabilities.layer.pipe(
		Layer.provide(Layer.merge(BunServices.layer, config))
	)
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
	body: () => Effect.Effect<void, E, Layer.Success<typeof platform> | McpClient>
) =>
	it(
		name,
		() => server.runPromise(Effect.timeout(body(), testTimeout)),
		Duration.toMillis(Duration.times(testTimeout, 2))
	);

/** Runs `mx <args>` as a process of its own on `system`: how it exited, and what it printed to stdout and stderr. */
const runOn =
	(system: typeof platform) =>
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
	(system: typeof platform) =>
	(...args: string[]) =>
		Effect.flatMap(runOn(system)(...args), ({ exit, output }) =>
			Effect.as(exit, { output })
		);
const run = runOn(platform);
const cli = cliOn(platform);

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
 * `platform` on a terminal where the user presses `keys` in turn across every prompt; `frames` keeps what mx drew, and
 * `drawn` runs on each frame as mx draws it, before the user presses the next key.
 */
const terminalWith = (
	keys: readonly string[],
	drawn: (frame: string) => void = () => undefined
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
	return { frames, system: Layer.merge(platform, terminal) };
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

	test("mx login --account adds an account with its own client id and tenant, saves its sign-in as refresh-token-2 and who signed in, learns who the first account is with one refresh under that account's client id, and names the accounts and mx rename", () =>
		Effect.gen(function* () {
			microsoft.signingIn = pat;
			const before = signInRequests().length;
			const { output } = yield* cli(
				"login",
				"--account",
				"personal",
				"--client-id",
				otherClientId,
				"--tenant",
				"example.org"
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
		}));

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
					"SELECT account, path, total FROM folders WHERE account != 'work'"
				)
			).toEqual(["account\tpath\ttotal", "account 9\tInbox\t1"]);
		}));

	test("mx status shows each account with who signed in, its sign-in, client id and tenant, and mx uninstall removes every account's sign-in", () =>
		Effect.gen(function* () {
			const report = lines((yield* run("status")).output);
			expect(
				report.slice(
					report.indexOf("Account work: sam@example.test"),
					report.indexOf("Last error: none")
				)
			).toEqual([
				"Account work: sam@example.test",
				"Sign-in: saved",
				`Client id: ${clientId}`,
				`Tenant: ${tenant}`,
				"Account personal: pat@example.org",
				"Sign-in: saved",
				`Client id: ${otherClientId}`,
				"Tenant: example.org",
				"Account travel: ana@example.net",
				"Sign-in: saved",
				`Client id: ${thirdClientId}`,
				"Tenant: example.net",
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
