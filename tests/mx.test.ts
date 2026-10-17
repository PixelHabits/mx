import { afterAll, describe, expect, it, mock } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
	Array as Arr,
	type Cause,
	ConfigProvider,
	Context,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	ManagedRuntime,
	Option,
	Queue,
	Record as Rec,
	Schema,
	Terminal,
} from "effect";
import { Command } from "effect/cli";
import type { ChildProcess } from "effect/process";
import { TestClock, TestConsole } from "effect/testing";
import packageJson from "../package.json" with { type: "json" };
import { savedConfig } from "../src/auth/config.ts";
import { mx } from "../src/cli.ts";
import { Paths } from "../src/paths.ts";
import { deleteAfterExit, stopSync } from "../src/windows.ts";
import {
	FakeMicrosoft,
	inlineImage,
	loginHost,
	uploadOrigin,
	userCode,
	verificationUri,
} from "./fake-microsoft.ts";
import { FakeProcesses } from "./fake-processes.ts";
import { FakeReleases, releasesPath } from "./fake-releases.ts";
import { FakeSecrets } from "./fake-secrets.ts";
import { connect, McpClient } from "./mcp-client.ts";

/** The temporary home every XDG directory sits in. */
class Home extends Context.Service<Home, string>()("mx/tests/mx.test/Home") {}

const releases = await FakeReleases.make();
// mx trusts only the release key it imports; the tests sign their releases with a throwaway key instead.
mock.module("../release/public-key.pem", () => ({
	default: releases.publicKey,
}));

/** The version this checkout builds, and the releases above it. */
const running = packageJson.version;
const [major, minor] = running.split(".");
const later = (step: number) => `${major}.${Number(minor) + step}.0`;
const microsoft = new FakeMicrosoft(releases);
const processes = new FakeProcesses(microsoft.tunnels);
const secrets = new FakeSecrets();
secrets.install();

const machine = ManagedRuntime.make(
	Layer.effect(
		Home,
		Effect.flatMap(FileSystem.FileSystem, (fs) =>
			fs.makeTempDirectoryScoped({ prefix: "mx-test-" })
		)
	).pipe(Layer.provideMerge(BunServices.layer))
);
const home = await machine.runPromise(Home);

/** The client id the tests sign in with, and another one, and the tenant. */
const clientId = "11111111-2222-4333-8444-555555555555";
const otherClientId = "66666666-7777-4888-9999-000000000000";
const tenant = "contoso.com";

/** The cloudflared `MX_CLOUDFLARED` names; the fake processes run it as a quick tunnel. */
const cloudflared = `${home}/bin/cloudflared`;

/** The environment of an mx process: its folders under the test home, cloudflared, a client id and a tenant. */
const environment = {
	APPDATA: `${home}/AppData/Roaming`,
	HOME: home,
	LOCALAPPDATA: `${home}/AppData/Local`,
	MX_CLIENT_ID: clientId,
	MX_CLOUDFLARED: cloudflared,
	MX_TENANT: tenant,
	PATH: `${home}/path`,
	USERPROFILE: home,
	XDG_CACHE_HOME: `${home}/cache`,
	XDG_CONFIG_HOME: `${home}/config`,
	XDG_DATA_HOME: `${home}/data`,
	XDG_STATE_HOME: `${home}/state`,
};

/**
 * What every mx process runs on: Microsoft and the internet, Bun with faked child processes, a console that keeps its
 * lines, and Config over `env` and the saved config.json, as `src/main.ts` sets it up.
 */
const platformWith = (env: Record<string, string>) =>
	Layer.mergeAll(
		microsoft.layer,
		BunServices.layer,
		processes.layer,
		TestConsole.layer,
		savedConfig.pipe(
			Layer.provide(Paths.layer),
			Layer.provide(
				Layer.merge(
					BunServices.layer,
					ConfigProvider.layer(ConfigProvider.fromUnknown(env))
				)
			)
		),
		Layer.succeed(Home, home)
	);
const platform = platformWith(environment);

/** `platform` without `MX_CLIENT_ID` and `MX_TENANT`, where only config.json can name a client id and a tenant. */
const { MX_CLIENT_ID: _, MX_TENANT: __, ...withoutSignIn } = environment;
const unconfigured = platformWith(withoutSignIn);

/** `mx mcp` as Claude Code starts it, one process for every test, with a client on its stdio. */
const server = ManagedRuntime.make(
	Layer.effect(
		McpClient,
		Effect.gen(function* () {
			const { client, stdio } = yield* connect;
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

const test = <E>(
	name: string,
	body: () => Effect.Effect<void, E, Layer.Success<typeof platform> | McpClient>
) => it(name, () => server.runPromise(body()), 30_000);

/** Everything any mx process printed, to check that no token ever shows. */
const printed: string[] = [];

/** Runs `mx <args>` as a process of its own on `system` and answers what it printed to stdout. */
const cliOn =
	(system: typeof platform) =>
	(...args: string[]) =>
		Command.runWith(mx, { version: "0.0.0-test" })(args).pipe(
			Effect.andThen(
				Effect.all({
					errors: TestConsole.errorLines,
					output: TestConsole.logLines,
				})
			),
			Effect.map(({ errors, output }) => {
				printed.push(...Arr.map([...errors, ...output], String));
				return { output: Arr.join(Arr.map(output, String), "\n") };
			}),
			// @effect-diagnostics-next-line strictEffectProvide:off - each call is the entry point of one mx process.
			Effect.provide(system, { local: true })
		);

const cli = cliOn(platform);

/** Runs `effect` with stdin a terminal or not; mx asks for what a command needs only on a terminal. */
const withStdinTerminal =
	(isTTY: boolean) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const before = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
				Object.defineProperty(process.stdin, "isTTY", {
					configurable: true,
					value: isTTY,
				});
				return before;
			}),
			() => effect,
			(before) =>
				Effect.sync(() => {
					if (before === undefined) {
						Reflect.deleteProperty(process.stdin, "isTTY");
					} else {
						Object.defineProperty(process.stdin, "isTTY", before);
					}
				})
		);

/**
 * `system` on a terminal where the user presses `keys` in turn, across every prompt: a key of one character types it,
 * and a longer one, such as `return`, presses the key of that name. `frames` keeps everything mx drew on it.
 */
const fakeTerminal = (system: typeof platform, keys: readonly string[]) => {
	const frames: string[] = [];
	let input: Queue.Queue<Terminal.UserInput, Cause.Done> | undefined;
	const terminal = Layer.succeed(
		Terminal.Terminal,
		Terminal.make({
			columns: Effect.succeed(80),
			display: (text) =>
				Effect.sync(() => {
					frames.push(text);
				}),
			readInput: Effect.gen(function* () {
				if (input === undefined) {
					input = yield* Queue.make<Terminal.UserInput, Cause.Done>();
					yield* Queue.offerAll(
						input,
						Arr.map(keys, (name) => ({
							input: name.length === 1 ? Option.some(name) : Option.none(),
							key: { ctrl: false, meta: false, name, shift: false },
						}))
					);
				}
				return input;
			}),
			readLine: Effect.die("mx reads no lines from the terminal."),
			rows: Effect.succeed(24),
		})
	);
	return { frames, system: Layer.merge(system, terminal) };
};

/** Runs `effect` as if on Windows; mx reads `process.platform` as it builds its layers. */
const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const actual = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			return actual;
		}),
		() => effect,
		(actual) =>
			Effect.sync(() => {
				Object.defineProperty(process, "platform", { value: actual });
			})
	);

/** Runs `effect` as if mx ran from the binary `exe`; mx reads `process.execPath` as it builds its layers. */
const runningAs =
	(exe: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const actual = process.execPath;
				Object.defineProperty(process, "execPath", { value: exe });
				return actual;
			}),
			() => effect,
			(actual) =>
				Effect.sync(() => {
					Object.defineProperty(process, "execPath", { value: actual });
				})
		);

/** `platform` where the process dies 4 bytes into each write into `folder`, as when the machine stops mid-write. */
const cutOffWrites = (folder: string) =>
	Layer.merge(
		platform,
		Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (fs) =>
				FileSystem.FileSystem.of({
					...fs,
					writeFile: (file, data, options) =>
						file.startsWith(folder)
							? fs
									.writeFile(file, data.subarray(0, 4), options)
									.pipe(Effect.andThen(Effect.die("The machine stopped.")))
							: fs.writeFile(file, data, options),
				})
			)
		).pipe(Layer.provide(BunServices.layer))
	);

const call = (name: string, args: Record<string, unknown>) =>
	McpClient.use((client) => client.call(name, args));

/** A tool's text; a tool error fails the test with the error's text. */
const tool = (name: string, args: Record<string, unknown> = {}) =>
	Effect.flatMap(call(name, args), ({ isError, text }) =>
		isError
			? Effect.die(`${name} answered an error: ${text}`)
			: Effect.succeed(text)
	);

/** A tool's error text; a success fails the test. */
const refusal = (name: string, args: Record<string, unknown>) =>
	Effect.flatMap(call(name, args), ({ isError, text }) =>
		isError ? Effect.succeed(text) : Effect.die(`${name} succeeded: ${text}`)
	);

const lines = (text: string) => text.split("\n");

const listedId = /^#(\d+) /u;

/** The local id of the one listed message whose line contains `needle`. */
const idOf = (listing: string, needle: string) => {
	const [line, ...others] = Arr.filter(lines(listing), (candidate) =>
		candidate.includes(needle)
	);
	const id = listedId.exec(line ?? "")?.[1];
	if (id === undefined || others.length > 0) {
		throw new Error(`Expected one line with ${needle} in:\n${listing}`);
	}
	return Number(id);
};

const loginRequests = () =>
	Arr.filter(
		microsoft.received,
		(request) => request.url.hostname === loginHost
	);
const tokenForms = () =>
	Arr.map(loginRequests(), (request) => new URLSearchParams(request.body));
/** The tenant each sign-in request named in its path, `/<tenant>/oauth2/v2.0/...`. */
const tenantsAsked = () =>
	Arr.map(loginRequests(), (request) => request.url.pathname.split("/")[1]);

const graphRequests = (suffix: string) =>
	Arr.filter(microsoft.graphRequests(), (request) =>
		request.url.pathname.endsWith(suffix)
	);

const tokenFile = `${home}/state/mx/refresh-token`;
const configFile = `${home}/config/mx/config.json`;

/** The refresh token of the sign-in mx saved as `text`, in the secret store or in the sign-in file. */
const refreshTokenIn = (text: string | null | undefined) =>
	Schema.decodeUnknownEffect(
		Schema.fromJsonString(Schema.Struct({ refreshToken: Schema.String }))
	)(text).pipe(
		Effect.map(({ refreshToken }) => refreshToken),
		Effect.orDie
	);
const savedRefreshToken = Effect.suspend(() =>
	refreshTokenIn(secrets.entries.get("mx/refresh-token"))
);

const devicecodeRequests = () =>
	Arr.filter(microsoft.received, (request) =>
		request.url.pathname.endsWith("/devicecode")
	).length;

/** Runs `check` on the real clock until it answers true, for up to 10 seconds. */
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

/** Lets work that the test does not wait on run for a while on the real clock. */
const settle = Effect.promise(() => Bun.sleep(1500));

const deltaRequests = (folderId: string) =>
	Arr.filter(graphRequests("/messages/delta"), (request) =>
		request.url.pathname.includes(`/${folderId}/`)
	).length;

const allFolders = [
	"folder-inbox",
	"folder-projects",
	"folder-sent",
	"folder-drafts",
	"folder-deleted",
	"folder-archive",
];

const installed = `${home}/.local/bin/mx`;
const windowsFolder = `${home}/AppData/Local/Programs/mx`;
const background = `${windowsFolder}/mxw.exe`;

/** A command as `processes.commands` records it, joined by spaces. */
const commandLine = (command: ChildProcess.StandardCommand) =>
	Arr.join([command.command, ...command.args], " ");

const newBinary = new TextEncoder().encode(`synthetic mx ${later(1)} binary`);
const otherBinary = new TextEncoder().encode(
	"synthetic binary nobody released"
);

/** How often mx downloaded the binary of `version`. */
const downloads = (version: string) =>
	Arr.filter(microsoft.received, (request) =>
		request.url.pathname.startsWith(`${releasesPath}download/v${version}/`)
	).length;
const unitFile = `${home}/config/systemd/user/mx-sync.service`;
const claudeCli = `${home}/path/claude`;
const codexConfig = `${home}/.codex/config.toml`;
const codexSettings = 'model = "gpt-6.1-sol"\n';

/** `mx sync` running as the service does, from the first push test to the last. */
const services: Fiber.Fiber<unknown, unknown>[] = [];

/** The refresh token Microsoft issued `back` tokens ago, 1 for the newest. */
const issued = (back: number) => microsoft.refreshTokens.at(-back) ?? "none";

const parseJson = (text: string) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.orDie
	);
const readJson = (file: string) =>
	Effect.flatMap(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)),
		parseJson
	);
const secrets_ = /synthetic-(access|refresh)-token|synthetic-device-code/u;
const ownSentLine = /^#\d+ .* Sent Items \(me\)$/mu;
const imageLine = /^1 image001\.png .*inline\)$/u;
const sheetLine = /^2 budget\.xls /u;
const earlyDraftLine =
	/^#\d+ .* Drafts \| to bob@example\.test \| Before sync \| draft$/u;
const replyDraftLine = /^#\d+ .* Drafts \| to Carol Example/u;
const permanent = /permanentDelete/u;
const loopbackUrl = /^http:\/\/127\.0\.0\.1:\d+$/u;
const loopbackAddress = /^127\.0\.0\.1:\d+$/u;
const lineIn = (id: number, folder: string) =>
	new RegExp(`^#${id} .* ${folder} \\|`, "u");

const tools = [
	"attachment",
	"delete",
	"delete_draft",
	"draft",
	"message",
	"search",
	"send",
	"thread",
	"update",
	"update_draft",
];

describe("mx", () => {
	test("mx mcp speaks MCP 2026-07-28 only and lists the ten tools, marking reads read-only and every write but draft destructive", () =>
		Effect.gen(function* () {
			const client = yield* McpClient;
			expect(yield* client.request("server/discover")).toMatchObject({
				supportedVersions: ["2026-07-28"],
			});
			const { tools: listed } = (yield* client.request("tools/list")) as {
				tools: {
					annotations: Record<string, boolean>;
					inputSchema: Record<string, unknown>;
					name: string;
				}[];
			};
			expect(Arr.map(listed, (entry) => entry.name).sort()).toEqual(tools);
			const hints = Rec.fromEntries(
				Arr.map(listed, ({ annotations, name }) => [
					name,
					`${annotations.readOnlyHint ? "read" : "write"} ${annotations.destructiveHint ? "destructive" : "safe"}`,
				])
			);
			expect(hints).toEqual({
				attachment: "read safe",
				delete: "write destructive",
				delete_draft: "write destructive",
				draft: "write safe",
				message: "read safe",
				search: "read safe",
				send: "write destructive",
				thread: "read safe",
				update: "write destructive",
				update_draft: "write destructive",
			});
			for (const { inputSchema } of listed) {
				expect(inputSchema.type).toBe("object");
				expect(inputSchema.anyOf).toBeUndefined();
			}
		}));

	test("run from source with no client id saved and no terminal, mx login fails, says how to give the client id, and saves nothing", () =>
		Effect.gen(function* () {
			const login = Bun.spawn(
				[process.execPath, "--no-env-file", "src/main.ts", "login"],
				{
					cwd: `${import.meta.dir}/..`,
					env: {
						HOME: home,
						// Nothing reaches Microsoft: every request goes to a closed port.
						HTTPS_PROXY: "http://127.0.0.1:9",
						XDG_CACHE_HOME: `${home}/cache`,
						XDG_CONFIG_HOME: `${home}/config`,
						XDG_DATA_HOME: `${home}/data`,
						XDG_STATE_HOME: `${home}/state`,
					},
					stderr: "pipe",
					stdin: "ignore",
					stdout: "pipe",
				}
			);
			const [code, errors] = yield* Effect.promise(() =>
				Promise.all([login.exited, new Response(login.stderr).text()])
			);
			expect(code).not.toBe(0);
			expect(errors).toContain("mx login --client-id <client id>");
			expect(yield* (yield* FileSystem.FileSystem).exists(configFile)).toBe(
				false
			);
		}));

	test("mx login signs in at the tenant it is given, asks for Mail.Send, and saves the refresh token in the secret store", () =>
		Effect.gen(function* () {
			const { output } = yield* cli("login");
			expect(new Set(tenantsAsked())).toEqual(new Set([tenant]));
			expect(output).toContain(verificationUri);
			expect(output).toContain(userCode);
			const forms = tokenForms();
			expect(forms[0]?.get("client_id")).toBe(clientId);
			expect(forms[0]?.get("scope")).toBe(
				"https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access"
			);
			expect(
				Arr.filter(
					forms,
					(form) =>
						form.get("grant_type") ===
						"urn:ietf:params:oauth:grant-type:device_code"
				)
			).toHaveLength(2);
			expect(yield* savedRefreshToken).toBe(issued(1));
			expect(yield* (yield* FileSystem.FileSystem).exists(tokenFile)).toBe(
				false
			);
		}));

	test("mx login asks for the client id and the tenant once, where Enter keeps organizations, saves both in config.json and signs in with them", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.remove(configFile, { force: true });
			const { frames, system } = fakeTerminal(unconfigured, [
				...clientId,
				"return",
				"return",
			]);
			yield* withStdinTerminal(true)(cliOn(system)("login"));
			const drawn = Arr.join(frames, "");
			expect(drawn).toContain("Client id");
			expect(drawn).toContain("Tenant");
			expect(yield* readJson(configFile)).toEqual({
				clientId,
				tenant: "organizations",
			});
			expect(tokenForms().at(-1)?.get("client_id")).toBe(clientId);
			expect(tenantsAsked().at(-1)).toBe("organizations");
			yield* withStdinTerminal(false)(cliOn(unconfigured)("login"));
			expect(tokenForms().at(-1)?.get("client_id")).toBe(clientId);
			expect(tenantsAsked().at(-1)).toBe("organizations");
			expect(yield* savedRefreshToken).toBe(issued(1));
		}));

	test("mx login with another client id deletes the saved sign-in before it signs in with that one", () =>
		Effect.gen(function* () {
			microsoft.pendingPolls = 3;
			const asked = devicecodeRequests();
			const login = yield* Effect.forkChild(
				cliOn(unconfigured)("login", "--client-id", otherClientId)
			);
			yield* eventually("a device code", () => devicecodeRequests() > asked);
			expect(secrets.entries.has("mx/refresh-token")).toBe(false);
			expect(yield* readJson(configFile)).toEqual({
				clientId: otherClientId,
				tenant: "organizations",
			});
			yield* Fiber.join(login);
			expect(tokenForms().at(-1)?.get("client_id")).toBe(otherClientId);
			expect(yield* savedRefreshToken).toBe(issued(1));
		}));

	test("mx login with another tenant deletes the saved sign-in before it signs in at that tenant", () =>
		Effect.gen(function* () {
			microsoft.pendingPolls = 3;
			const asked = devicecodeRequests();
			const login = yield* Effect.forkChild(
				cliOn(unconfigured)("login", "--tenant", tenant)
			);
			yield* eventually("a device code", () => devicecodeRequests() > asked);
			expect(secrets.entries.has("mx/refresh-token")).toBe(false);
			expect(yield* readJson(configFile)).toEqual({
				clientId: otherClientId,
				tenant,
			});
			yield* Fiber.join(login);
			expect(tenantsAsked().at(-1)).toBe(tenant);
			expect(yield* savedRefreshToken).toBe(issued(1));
		}));

	test("mx login refuses a tenant that is not organizations, a GUID or a domain, and changes nothing", () =>
		Effect.gen(function* () {
			const before = yield* readJson(configFile);
			const asked = devicecodeRequests();
			yield* Effect.flip(cliOn(unconfigured)("login", "--tenant", "contoso"));
			expect(devicecodeRequests()).toBe(asked);
			expect(yield* readJson(configFile)).toEqual(before);
		}));

	test("without a secret store, mx login saves the refresh token in a file only the user can read", () =>
		Effect.gen(function* () {
			secrets.machine = "none";
			yield* cli("login");
			const fs = yield* FileSystem.FileSystem;
			expect((yield* fs.stat(tokenFile)).mode % 0o1000).toBe(0o600);
			expect(yield* refreshTokenIn(yield* fs.readFileString(tokenFile))).toBe(
				issued(1)
			);
		}));

	test("a secret store that fails for any other reason fails loudly and writes no file", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const before = yield* fs.readFileString(tokenFile);
			secrets.machine = "broken";
			const failure = yield* Effect.flip(cli("login"));
			secrets.machine = "none";
			expect(failure.message).toContain(
				"The secret store failed: Could not connect"
			);
			expect(yield* fs.readFileString(tokenFile)).toBe(before);
		}));

	test("a draft written before the first sync is stored with its folder and answers its local id", () =>
		Effect.gen(function* () {
			expect(
				yield* tool("draft", {
					body: "Early.",
					kind: "new",
					subject: "Before sync",
					to: ["bob@example.test"],
				})
			).toMatch(earlyDraftLine);
		}));

	test("after mx login signs in with another client id, the running mx mcp sends Graph only the new sign-in's access token and refreshes it with that client id", () =>
		Effect.gen(function* () {
			const id = idOf(yield* tool("search", { query: "before sync" }), "#");
			yield* tool("message", { full: true, id });
			const graphBefore = microsoft.graphRequests().length;
			const formsBefore = tokenForms().length;
			yield* cliOn(unconfigured)("login", "--client-id", otherClientId);
			yield* tool("message", { full: true, id });
			expect(
				new Set(
					Arr.map(
						microsoft.graphRequests().slice(graphBefore),
						(request) => request.authorization
					)
				)
			).toEqual(
				new Set([
					`Bearer synthetic-access-token-${microsoft.refreshTokens.length}`,
				])
			);
			expect(
				Arr.map(
					Arr.filter(
						tokenForms().slice(formsBefore),
						(form) => form.get("grant_type") === "refresh_token"
					),
					(form) => form.get("client_id")
				)
			).toEqual([otherClientId]);
		}));

	test("mx login restarts mx sync where mx install registered it, so sync runs under the new sign-in", () =>
		Effect.gen(function* () {
			const before = processes.commands.length;
			const { output } = yield* cliOn(unconfigured)("login");
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual([
				"systemctl --user is-enabled --quiet mx-sync.service",
				"systemctl --user restart --no-block mx-sync.service",
			]);
			expect(lines(output).at(-1)).toBe("Restarted mx sync.");
		}));

	test("mx sync --once stores every mail folder, child folders included, through Graph delta with text bodies and immutable ids", () =>
		Effect.gen(function* () {
			microsoft.throttle = 1;
			yield* cli("sync", "--once");
			const deltas = graphRequests("/messages/delta");
			expect(
				new Set(
					Arr.map(deltas, (request) => request.url.pathname.split("/")[4])
				)
			).toEqual(
				new Set([
					"folder-inbox",
					"folder-projects",
					"folder-sent",
					"folder-drafts",
					"folder-deleted",
					"folder-archive",
				])
			);
			for (const request of deltas) {
				expect(request.prefer).toContain('outlook.body-content-type="text"');
				expect(request.prefer).toContain('IdType="ImmutableId"');
			}
			const answer = yield* call("search", { limit: 50 });
			expect(answer.structured).toBeUndefined();
			expect(lines(answer.text)).toHaveLength(6);
			expect(answer.text).toContain("Inbox/Projects | Bob Example");
		}));

	test("each refresh saves the rotated refresh token, so the next process refreshes with the new one", () =>
		Effect.gen(function* () {
			const before = Arr.filter(
				tokenForms(),
				(form) => form.get("grant_type") === "refresh_token"
			).length;
			yield* cli("sync", "--once");
			const refreshes = Arr.filter(
				tokenForms(),
				(form) => form.get("grant_type") === "refresh_token"
			);
			expect(refreshes).toHaveLength(before + 1);
			expect(refreshes.at(-1)?.get("refresh_token")).toBe(issued(2));
			expect(
				yield* refreshTokenIn(
					yield* (yield* FileSystem.FileSystem).readFileString(tokenFile)
				)
			).toBe(issued(1));
		}));

	test("search finds by words in the subject, the sender and the new text, with folder, from and since filters", () =>
		Effect.gen(function* () {
			expect(lines(yield* tool("search", { query: "travel" }))).toHaveLength(2);
			expect(yield* tool("search", { query: "carol" })).toContain(
				"Lunch plans"
			);
			const inbox = yield* tool("search", { folder: "Inbox", query: "budget" });
			expect(lines(inbox)).toHaveLength(2);
			expect(inbox).not.toContain("Sent Items");
			expect(
				lines(yield* tool("search", { from: "alice@example.test" }))
			).toHaveLength(2);
			const since = yield* tool("search", { since: "2026-10-03" });
			expect(since).toContain("Lunch plans");
			expect(since).not.toContain("Kickoff notes");
			expect(yield* tool("search", { query: "nothing-matches-this" })).toBe(
				"No messages."
			);
		}));

	test("thread returns the conversation across Inbox and Sent Items, oldest first, marking the user's own message", () =>
		Effect.gen(function* () {
			const id = idOf(yield* tool("search", { query: "travel cap" }), "RE:");
			const thread = yield* tool("thread", { id });
			const order = Arr.map(
				[
					"Please review the quarterly budget.",
					"Looks fine. One question about travel.",
					"Travel stays under the cap.",
				],
				(text) => thread.indexOf(text)
			);
			expect(Arr.every(order, (index) => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(thread).toMatch(ownSentLine);
			expect(thread).not.toContain("From: Devin Example");
			expect(thread).toContain("[img 1]");
		}));

	test("message shows the headers and the new text, and the whole body from Graph with full", () =>
		Effect.gen(function* () {
			const id = idOf(yield* tool("search", { query: "travel cap" }), "RE:");
			const short = yield* tool("message", { id });
			expect(short).toContain("From: Alice Example <alice@example.test>");
			expect(short).toContain("Travel stays under the cap.");
			expect(short).not.toContain("Looks fine.");
			expect(yield* tool("message", { full: true, id })).toContain(
				"Looks fine."
			);
		}));

	test("attachment lists the attachments with the inline image in body order, and with n saves that one under the cache", () =>
		Effect.gen(function* () {
			const id = idOf(yield* tool("search", { query: "review" }), "Quarterly");
			const listing = lines(yield* tool("attachment", { id }));
			expect(listing[0]).toMatch(imageLine);
			expect(listing[1]).toMatch(sheetLine);
			const saved = yield* tool("attachment", { id, n: 1 });
			expect(saved.startsWith(`${home}/cache/mx/`)).toBe(true);
			const fs = yield* FileSystem.FileSystem;
			expect([...(yield* fs.readFile(saved))]).toEqual([...inlineImage]);
		}));

	test("draft replies, replies to all and forwards with the quoted chain, and builds a new message with files", () =>
		Effect.gen(function* () {
			const lunch = idOf(yield* tool("search", { query: "lunch" }), "Lunch");
			const reply = yield* tool("draft", {
				body: "Friday works for me.",
				kind: "reply",
				message: lunch,
			});
			expect(reply).toMatch(replyDraftLine);
			expect(graphRequests("/createReply")[0]?.body).toBe(
				'{"comment":"Friday works for me."}'
			);
			expect(
				yield* tool("message", { full: true, id: idOf(reply, "Drafts") })
			).toContain("Lunch on Friday?");

			const kickoff = idOf(
				yield* tool("search", { query: "kickoff" }),
				"Kickoff"
			);
			const forward = yield* tool("draft", {
				body: "See below.",
				cc: ["alice@example.test"],
				kind: "forward",
				message: kickoff,
				to: ["carol@example.test"],
			});
			expect(forward).toContain("to carol@example.test | FW: Kickoff notes");
			expect(yield* tool("message", { id: idOf(forward, "FW:") })).toContain(
				"Cc: alice@example.test"
			);
			expect(
				yield* tool("message", { full: true, id: idOf(forward, "FW:") })
			).toContain("Kickoff is on Thursday.");

			const fs = yield* FileSystem.FileSystem;
			const small = `${home}/agenda.txt`;
			const large = `${home}/minutes.txt`;
			yield* fs.writeFileString(small, "synthetic agenda");
			yield* fs.writeFileString(large, "m".repeat(5_000_000));
			const created = yield* tool("draft", {
				attach: [small, large],
				bcc: ["carol@example.test"],
				body: "First draft.",
				kind: "new",
				subject: "Agenda",
				to: ["bob@example.test"],
			});
			const attachments = yield* tool("attachment", {
				id: idOf(created, "Agenda"),
			});
			expect(attachments).toContain("agenda.txt");
			expect(attachments).toContain("minutes.txt");
			const uploads = Arr.filter(
				microsoft.received,
				(request) => request.url.origin === uploadOrigin
			);
			expect(uploads.length).toBeGreaterThan(1);
			expect(
				Arr.every(uploads, (request) => request.authorization === null)
			).toBe(true);
			expect((yield* call("draft", { kind: "reply" })).text).toContain(
				"needs message"
			);
		}));

	test("update_draft replaces recipients, subject and body and adds files; it and delete_draft refuse a message that is not a draft", () =>
		Effect.gen(function* () {
			const id = idOf(
				yield* tool("search", { folder: "Drafts", query: "agenda" }),
				"Agenda"
			);
			const fs = yield* FileSystem.FileSystem;
			const notes = `${home}/notes.txt`;
			yield* fs.writeFileString(notes, "synthetic notes");
			expect(
				yield* tool("update_draft", {
					attach: [notes],
					body: "Second draft.",
					id,
					subject: "Agenda v2",
					to: ["alice@example.test"],
				})
			).toContain("to alice@example.test | Agenda v2");
			expect(yield* tool("message", { id })).toContain("Second draft.");
			expect(yield* tool("attachment", { id })).toContain("notes.txt");
			const received = idOf(
				yield* tool("search", { query: "kickoff" }),
				"Inbox/Projects"
			);
			expect(yield* refusal("update_draft", { body: "x", id: received })).toBe(
				`#${received} is not a draft.`
			);
			expect(yield* refusal("delete_draft", { id: received })).toBe(
				`#${received} is not a draft.`
			);
			const early = idOf(
				yield* tool("search", { query: "early" }),
				"Before sync"
			);
			expect(yield* tool("delete_draft", { id: early })).toMatch(
				lineIn(early, "Deleted Items")
			);
		}));

	test("send refuses a draft unless to, cc, bcc and subject repeat the draft's, and sends nothing; repeated, it sends the draft", () =>
		Effect.gen(function* () {
			const id = idOf(
				yield* tool("search", { folder: "Drafts", query: "agenda" }),
				"Agenda v2"
			);
			expect(yield* tool("message", { id })).toContain(
				"Bcc: carol@example.test"
			);
			const repeated = {
				bcc: ["carol@example.test"],
				cc: [],
				draft: id,
				subject: "Agenda v2",
				to: ["alice@example.test"],
			};
			expect(
				yield* refusal("send", { ...repeated, to: ["bob@example.test"] })
			).toContain("Nothing was sent");
			expect(
				yield* refusal("send", { ...repeated, subject: "Agenda" })
			).toContain("Nothing was sent");
			expect(
				yield* refusal("send", { ...repeated, cc: ["carol@example.test"] })
			).toContain("Nothing was sent");
			expect(yield* refusal("send", { ...repeated, bcc: [] })).toBe(
				`Nothing was sent: #${id} goes to alice@example.test; bcc carol@example.test with the subject "Agenda v2". Repeat to, cc, bcc and subject exactly to send it.`
			);
			expect(yield* refusal("send", { ...repeated, kind: "new" })).toContain(
				"not fields of both"
			);
			expect(graphRequests("/send")).toEqual([]);
			expect(
				yield* tool("send", {
					...repeated,
					bcc: ["Carol@Example.test"],
					to: ["Alice@Example.test"],
				})
			).toBe(
				`Sent #${id} to alice@example.test; bcc carol@example.test: Agenda v2`
			);
			expect(graphRequests("/send")).toHaveLength(1);
			expect(
				Arr.map(microsoft.inFolder("folder-sent"), (sent) => sent.subject)
			).toContain("Agenda v2");
			expect(yield* tool("search", { folder: "Drafts" })).not.toContain(
				"Agenda v2"
			);
		}));

	test("send at once posts sendMail for a new message and /reply for a reply, and sends files through a draft", () =>
		Effect.gen(function* () {
			yield* tool("send", {
				bcc: ["carol@example.test"],
				body: "See you there.",
				kind: "new",
				subject: "Offsite",
				to: ["bob@example.test"],
			});
			const sendMail = graphRequests("/me/sendMail");
			expect(sendMail).toHaveLength(1);
			expect(yield* parseJson(sendMail[0]?.body ?? "")).toMatchObject({
				message: {
					bccRecipients: [{ emailAddress: { address: "carol@example.test" } }],
					subject: "Offsite",
					toRecipients: [{ emailAddress: { address: "bob@example.test" } }],
				},
				saveToSentItems: true,
			});
			const budget = idOf(
				yield* tool("search", { query: "review" }),
				"Quarterly"
			);
			expect(
				yield* tool("send", {
					body: "Approved.",
					kind: "reply",
					message: budget,
				})
			).toBe(`Sent the reply to #${budget}.`);
			expect(graphRequests("/reply")[0]?.body).toBe('{"comment":"Approved."}');
			expect(
				Arr.map(microsoft.inFolder("folder-sent"), (sent) => sent.uniqueBody)
			).toContain("Approved.");

			const fs = yield* FileSystem.FileSystem;
			const file = `${home}/report.txt`;
			yield* fs.writeFileString(file, "synthetic report");
			const sends = graphRequests("/send").length;
			yield* tool("send", {
				attach: [file],
				body: "Report attached.",
				kind: "new",
				subject: "Report",
				to: ["alice@example.test"],
			});
			expect(graphRequests("/me/sendMail")).toHaveLength(1);
			expect(graphRequests("/send")).toHaveLength(sends + 1);
			const report = Arr.filter(
				microsoft.inFolder("folder-sent"),
				(sent) => sent.subject === "Report"
			);
			expect(Arr.map(report, (sent) => sent.attachments.length)).toEqual([1]);
		}));

	test("update reads, flags, categorizes and moves several messages, and each keeps its local id", () =>
		Effect.gen(function* () {
			const kickoff = idOf(
				yield* tool("search", { query: "kickoff" }),
				"Inbox/Projects"
			);
			const answer = idOf(
				yield* tool("search", { query: "travel cap" }),
				"Inbox"
			);
			const changed = lines(
				yield* tool("update", {
					categories: ["Projects"],
					flag: "flagged",
					ids: [kickoff, answer],
					move_to: "archive",
					read: true,
				})
			);
			expect(changed[0]).toMatch(lineIn(kickoff, "Archive"));
			expect(changed[1]).toMatch(lineIn(answer, "Archive"));
			expect(changed[0]).toContain("flagged");
			expect(changed[0]).not.toContain("unread");
			expect(yield* tool("message", { id: kickoff })).toContain(
				"Categories: Projects"
			);
			const partial = yield* refusal("update", {
				ids: [kickoff, 99_999],
				read: false,
			});
			expect(partial).toContain("#99999: No message #99999.");
			expect(yield* tool("message", { id: kickoff })).toContain("unread");
		}));

	test("update refuses to move messages to Deleted Items, where only delete moves them", () =>
		Effect.gen(function* () {
			const lunch = idOf(yield* tool("search", { query: "lunch" }), "Inbox");
			const moves = graphRequests("/move").length;
			expect(
				yield* refusal("update", { ids: [lunch], move_to: "Deleted Items" })
			).toContain("use delete");
			expect(graphRequests("/move")).toHaveLength(moves);
			expect(yield* tool("message", { id: lunch })).toMatch(
				lineIn(lunch, "Inbox")
			);
		}));

	test("delete moves several messages to Deleted Items and nothing deletes a message for good", () =>
		Effect.gen(function* () {
			const lunch = idOf(yield* tool("search", { query: "lunch" }), "Inbox");
			const kickoff = idOf(
				yield* tool("search", { query: "kickoff" }),
				"Archive"
			);
			const deleted = lines(yield* tool("delete", { ids: [lunch, kickoff] }));
			expect(deleted[0]).toMatch(lineIn(lunch, "Deleted Items"));
			expect(deleted[1]).toMatch(lineIn(kickoff, "Deleted Items"));
			expect(
				Arr.map(graphRequests("/move"), (request) => request.body)
			).toContain('{"destinationId":"deleteditems"}');
			expect(
				Arr.filter(
					microsoft.received,
					(request) =>
						request.method === "DELETE" || permanent.test(request.url.pathname)
				)
			).toEqual([]);
		}));

	test("a message removed in Outlook leaves the store on the next sync", () =>
		Effect.gen(function* () {
			const id = idOf(yield* tool("search", { query: "travel cap" }), "RE:");
			microsoft.purge("message-answer");
			yield* cli("sync", "--once");
			expect(yield* tool("search", { query: "travel cap" })).toBe(
				"No messages."
			);
			expect((yield* call("message", { id })).isError).toBe(true);
		}));

	test("a local id names one message for the life of the store: a message moved in Outlook keeps it, and a sent draft's id goes to no other message", () =>
		Effect.gen(function* () {
			const budget = idOf(
				yield* tool("search", { query: "review" }),
				"Quarterly"
			);
			microsoft.move("message-budget", "folder-archive");
			yield* cli("sync", "--once");
			expect(yield* tool("message", { id: budget })).toMatch(
				lineIn(budget, "Archive")
			);
			const sent = idOf(
				yield* tool("draft", {
					kind: "new",
					subject: "Sent once",
					to: ["bob@example.test"],
				}),
				"Sent once"
			);
			yield* tool("send", {
				bcc: [],
				cc: [],
				draft: sent,
				subject: "Sent once",
				to: ["bob@example.test"],
			});
			const next = idOf(
				yield* tool("draft", { kind: "new", subject: "Drafted next" }),
				"Drafted next"
			);
			expect(next).not.toBe(sent);
		}));

	test("mx sync deletes stale subscriptions and subscribes Inbox and Sent Items for created, updated and deleted mail through a validated quick tunnel", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(`${home}/bin`, { recursive: true });
			yield* fs.writeFileString(cloudflared, "");
			const stale = microsoft.subscriptions.seed({
				changeType: "created,updated,deleted",
				clientState: "an earlier run",
				expirationDateTime: "2026-10-07T00:00:00Z",
				lifecycleNotificationUrl: "https://old-tunnel.trycloudflare.com/graph",
				notificationUrl: "https://old-tunnel.trycloudflare.com/graph",
				resource: "me/mailFolders('inbox')/messages",
			});
			const foreign = microsoft.subscriptions.seed({
				changeType: "created",
				clientState: "another tool",
				expirationDateTime: "2026-10-07T00:00:00Z",
				lifecycleNotificationUrl: "https://hooks.example.test/mail",
				notificationUrl: "https://hooks.example.test/mail",
				resource: "me/mailFolders('inbox')/messages",
			});
			services.push(yield* Effect.forkDetach(cli("sync")));
			const url = "https://tunnel-1.trycloudflare.com/graph";
			yield* eventually("both subscriptions", () =>
				Arr.every(["inbox", "sentitems"], (folder) =>
					Arr.some(
						microsoft.subscriptions.on(folder),
						(subscription) => subscription.notificationUrl === url
					)
				)
			);
			const ours = Arr.filter(
				[...microsoft.subscriptions.byId.values()],
				(subscription) => subscription.notificationUrl === url
			);
			expect(
				Arr.map(ours, (subscription) => subscription.resource).sort()
			).toEqual([
				"me/mailFolders('inbox')/messages",
				"me/mailFolders('sentitems')/messages",
			]);
			for (const subscription of ours) {
				expect(subscription.changeType).toBe("created,updated,deleted");
				expect(subscription.lifecycleNotificationUrl).toBe(url);
			}
			expect(microsoft.subscriptions.validated).toContain(url);
			expect(microsoft.subscriptions.byId.has(stale)).toBe(false);
			expect(microsoft.subscriptions.byId.has(foreign)).toBe(true);
			expect(
				Arr.findFirst(
					processes.commands,
					([command]) => command === cloudflared
				)
			).toEqual(
				Option.some([
					cloudflared,
					"tunnel",
					"--no-autoupdate",
					"--url",
					expect.stringMatching(loopbackUrl),
					"--metrics",
					expect.stringMatching(loopbackAddress),
				])
			);
		}));

	test("a change notification brings a new message into the store within seconds, and the webhook answers 202", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() => microsoft.receive("Push arrives"));
			expect(microsoft.subscriptions.delivered.at(-1)?.status).toBe(202);
			yield* eventually(
				"the pushed message in the store",
				Effect.map(call("search", { query: "push arrives" }), ({ text }) =>
					text.includes("Inbox | Bob Example <bob@example.test> | Push arrives")
				)
			);
		}));

	test("a notification without this run's clientState runs no pass", () =>
		Effect.gen(function* () {
			yield* settle;
			const before = deltaRequests("folder-inbox");
			yield* Effect.promise(() =>
				microsoft.subscriptions.notify(
					"inbox",
					"message-forged",
					"not the secret"
				)
			);
			yield* settle;
			expect(deltaRequests("folder-inbox")).toBe(before);
		}));

	test("reauthorizationRequired reauthorizes the subscription, and missed runs a delta pass of its folder", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				microsoft.subscriptions.lifecycle("inbox", "reauthorizationRequired")
			);
			const inbox = Arr.findFirst(
				microsoft.subscriptions.on("inbox"),
				(subscription) =>
					subscription.notificationUrl.endsWith(".trycloudflare.com/graph")
			).pipe(
				Option.map((subscription) => subscription.id),
				Option.getOrElse(() => "none")
			);
			yield* eventually("a reauthorize call", () =>
				microsoft.subscriptions.reauthorized.includes(inbox)
			);
			const before = deltaRequests("folder-sent");
			yield* Effect.promise(() =>
				microsoft.subscriptions.lifecycle("sentitems", "missed")
			);
			yield* eventually(
				"a delta pass of Sent Items",
				() => deltaRequests("folder-sent") > before
			);
		}));

	test("when cloudflared exits, a new tunnel starts, change and lifecycle notifications both reach it, and every folder gets a delta pass", () =>
		Effect.gen(function* () {
			const before = Arr.map(allFolders, deltaRequests);
			yield* processes.exit("tunnel-1.trycloudflare.com");
			const url = "https://tunnel-2.trycloudflare.com/graph";
			const onTunnels = (folder: string) =>
				Arr.filter(microsoft.subscriptions.on(folder), (subscription) =>
					subscription.notificationUrl.endsWith(".trycloudflare.com/graph")
				);
			yield* eventually("the subscriptions on the new host", () =>
				Arr.every(["inbox", "sentitems"], (folder) => {
					const [only, ...others] = onTunnels(folder);
					return (
						others.length === 0 &&
						only?.notificationUrl === url &&
						only.lifecycleNotificationUrl === url
					);
				})
			);
			const inbox = Arr.map(onTunnels("inbox"), ({ id }) => id);
			yield* Effect.promise(() =>
				microsoft.subscriptions.lifecycle("inbox", "reauthorizationRequired")
			);
			yield* eventually("a reauthorize call through the new tunnel", () =>
				Arr.every(inbox, (id) =>
					microsoft.subscriptions.reauthorized.includes(id)
				)
			);
			yield* eventually("a delta pass of every folder", () =>
				Arr.every(
					allFolders,
					(folder, index) => deltaRequests(folder) > (before[index] ?? 0)
				)
			);
		}));

	test("stopping mx sync deletes this run's subscriptions and leaves other tools' alone", () =>
		Effect.gen(function* () {
			yield* Effect.forEach(services, Fiber.interrupt);
			expect(
				Arr.map(
					[...microsoft.subscriptions.byId.values()],
					(subscription) => subscription.notificationUrl
				)
			).toEqual(["https://hooks.example.test/mail"]);
		}));

	test("without cloudflared, mx sync polls every folder every 60 seconds", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.remove(cloudflared);
			const before = deltaRequests("folder-archive");
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"the first pass",
				() => deltaRequests("folder-archive") > before
			);
			const first = deltaRequests("folder-archive");
			yield* TestClock.adjust("59 seconds");
			yield* settle;
			expect(deltaRequests("folder-archive")).toBe(first);
			yield* TestClock.adjust("1 second");
			yield* eventually(
				"the second pass",
				() => deltaRequests("folder-archive") > first
			);
			yield* Fiber.interrupt(service);
		}).pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test and its mx sync run on.
			Effect.provide(TestClock.layer())
		));

	test("mx install, run twice, installs the binary, enables the systemd unit, registers mx with Claude Code and Codex, and starts sync", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(`${home}/path`, { recursive: true });
			yield* fs.writeFileString(claudeCli, "");
			yield* fs.chmod(claudeCli, 0o755);
			yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
			yield* fs.writeFileString(codexConfig, codexSettings);
			const before = processes.commands.length;
			yield* cli("install");
			yield* cli("install");
			expect((yield* fs.stat(installed)).size).toBe(
				(yield* fs.stat(process.execPath)).size
			);
			expect((yield* fs.stat(installed)).mode % 0o1000).toBe(0o755);
			expect(yield* fs.readFileString(unitFile)).toContain(
				`ExecStart="${installed}" sync`
			);
			const once = [
				"systemctl --user daemon-reload",
				"systemctl --user enable mx-sync.service",
				`${claudeCli} mcp remove --scope user mx`,
				`${claudeCli} mcp add --scope user mx -- ${installed} mcp`,
				"systemctl --user restart --no-block mx-sync.service",
			];
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual([...once, ...once]);
			expect(yield* fs.readFileString(codexConfig)).toBe(
				`${codexSettings}\n[mcp_servers.mx]\nargs = ["mcp"]\ncommand = "${installed}"\n`
			);
		}));

	test("mx install on Windows that stops while it writes the new mx.exe leaves the installed one whole", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const exe = `${windowsFolder}/mx.exe`;
			const before = new TextEncoder().encode("synthetic installed mx.exe");
			yield* fs.makeDirectory(windowsFolder, { recursive: true });
			yield* fs.writeFile(exe, before);
			const exit = yield* Effect.exit(
				onWindows(cliOn(cutOffWrites(windowsFolder))("install"))
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect([...(yield* fs.readFile(exe))]).toEqual([...before]);
		}));

	test("mx update installs a newer signed release: it checks the signature, the size and the sha256, replaces the binary and restarts sync", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				releases.publish({ binary: newBinary, version: later(1) })
			);
			const before = processes.commands.length;
			const { output } = yield* cli("update");
			expect(output).toContain(`Updated mx to ${later(1)}`);
			const fs = yield* FileSystem.FileSystem;
			expect([...(yield* fs.readFile(installed))]).toEqual([...newBinary]);
			expect((yield* fs.stat(installed)).mode % 0o1000).toBe(0o755);
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual(["systemctl --user restart --no-block mx-sync.service"]);
		}));

	test("mx update refuses a manifest that another key signed, and installs nothing", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				releases.publish({
					binary: otherBinary,
					signedBy: "other",
					version: later(2),
				})
			);
			const failure = yield* Effect.flip(cli("update"));
			expect(failure.message).toContain("signature");
			expect(downloads(later(2))).toBe(0);
			expect([
				...(yield* (yield* FileSystem.FileSystem).readFile(installed)),
			]).toEqual([...newBinary]);
		}));

	test("mx update refuses a release that is not newer than the running binary", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				releases.publish({ binary: otherBinary, version: running })
			);
			const { output } = yield* cli("update");
			expect(output).toContain(`${running} is the newest release`);
			expect(downloads(running)).toBe(0);
			expect([
				...(yield* (yield* FileSystem.FileSystem).readFile(installed)),
			]).toEqual([...newBinary]);
		}));

	test("mx update refuses a binary whose sha256 differs from the signed manifest", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				releases.publish({
					binary: otherBinary,
					manifestSha256: "0".repeat(64),
					version: later(3),
				})
			);
			const failure = yield* Effect.flip(cli("update"));
			expect(failure.message).toContain("sha256");
			expect(downloads(later(3))).toBe(1);
			expect([
				...(yield* (yield* FileSystem.FileSystem).readFile(installed)),
			]).toEqual([...newBinary]);
		}));

	test("a refused refresh token fails loudly with run mx login, and no token is ever printed", () =>
		Effect.gen(function* () {
			microsoft.refuseRefresh = true;
			const failure = yield* Effect.flip(cli("sync", "--once"));
			expect(failure.message).toContain("Run mx login.");
			expect(String(failure)).not.toMatch(secrets_);
			expect(printed.length).toBeGreaterThan(0);
			expect(Arr.join(printed, "\n")).not.toMatch(secrets_);
		}));
	test("mx uninstall without --yes and without a terminal refuses and removes nothing", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const before = processes.commands.length;
			const failure = yield* Effect.flip(
				withStdinTerminal(false)(cli("uninstall"))
			);
			expect(failure.message).toContain("mx uninstall --yes");
			expect(processes.commands).toHaveLength(before);
			expect(yield* fs.exists(installed)).toBe(true);
			expect(yield* fs.exists(`${home}/data/mx/mx.sqlite`)).toBe(true);
		}));

	test("mx uninstall lists what it removes and asks first, and removes nothing when the answer is no", () =>
		Effect.gen(function* () {
			secrets.machine = "store";
			const fs = yield* FileSystem.FileSystem;
			const before = processes.commands.length;
			const { frames, system } = fakeTerminal(platform, ["n"]);
			const { output } = yield* withStdinTerminal(true)(
				cliOn(system)("uninstall")
			);
			const prompt = Arr.join(frames, "");
			for (const path of [
				installed,
				unitFile,
				configFile,
				`${home}/data/mx`,
				`${home}/cache/mx`,
				`${home}/state/mx`,
			]) {
				expect(prompt).toContain(path);
			}
			expect(prompt).toContain("the saved sign-in");
			expect(output).toBe("mx uninstall removed nothing.");
			expect(processes.commands).toHaveLength(before);
			expect(yield* fs.exists(installed)).toBe(true);
		}));

	test("mx uninstall --yes stops sync first, then removes the unit, the client registrations, the binary, the client id, the mail store, the sign-in, the cache and the state folder", () =>
		Effect.gen(function* () {
			secrets.machine = "store";
			const fs = yield* FileSystem.FileSystem;
			const before = processes.commands.length;
			let signedInWhenSyncStopped = false;
			processes.onSpawn = () => {
				signedInWhenSyncStopped ||= secrets.entries.has("mx/refresh-token");
			};
			yield* cli("uninstall", "--yes");
			processes.onSpawn = undefined;
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual([
				"systemctl --user disable --now mx-sync.service",
				"systemctl --user daemon-reload",
				`${claudeCli} mcp remove --scope user mx`,
			]);
			expect(signedInWhenSyncStopped).toBe(true);
			expect(yield* fs.readFileString(codexConfig)).toBe(codexSettings);
			for (const path of [
				installed,
				unitFile,
				configFile,
				`${home}/data/mx`,
				`${home}/cache/mx`,
				`${home}/state/mx`,
			]) {
				expect(yield* fs.exists(path)).toBe(false);
			}
			expect(secrets.entries.has("mx/refresh-token")).toBe(false);
		}));

	test("mx install on Windows adds the program folder to the user PATH once and keeps every other entry, and mx uninstall takes out only that folder", () =>
		onWindows(
			Effect.gen(function* () {
				const others =
					"%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\Zoë\\bin;;C:\\Tools\\";
				processes.userPath = others;
				const { output } = yield* cli("install");
				expect(output).toContain(
					`Added ${windowsFolder} to your PATH. Open a new terminal to run mx.`
				);
				yield* cli("install");
				expect(processes.userPath).toBe(`${others};${windowsFolder}`);
				yield* cli("uninstall", "--yes");
				expect(processes.userPath).toBe(others);
			})
		));

	test("on Windows, mx uninstall stops mx sync with the processes it started before it deletes anything", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* cli("install");
				const before = processes.commands.length;
				let installedWhenSyncStopped = false;
				processes.onSpawn = () => {
					installedWhenSyncStopped ||= Bun.file(background).size > 0;
				};
				yield* cli("uninstall", "--yes");
				processes.onSpawn = undefined;
				expect(Arr.join(processes.commands[before] ?? [], " ")).toBe(
					commandLine(stopSync(process.pid))
				);
				expect(installedWhenSyncStopped).toBe(true);
				expect(yield* fs.exists(background)).toBe(false);
			})
		));

	test("mx uninstall run from the installed mx.exe deletes mxw.exe and the copies an update moved aside at once, and the program folder once it exits", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const exe = `${windowsFolder}/mx.exe`;
				const movedAside = [
					`${windowsFolder}/mx.old.exe`,
					`${windowsFolder}/mxw.old.exe`,
				];
				yield* cli("install");
				yield* Effect.forEach(movedAside, (file) =>
					fs.writeFileString(file, "an exe an update moved aside")
				);
				const before = processes.commands.length;
				const { output } = yield* runningAs(exe)(cli("uninstall", "--yes"));
				for (const file of [background, ...movedAside]) {
					expect(yield* fs.exists(file)).toBe(false);
				}
				expect(yield* fs.exists(exe)).toBe(true);
				expect(
					Arr.map(processes.commands.slice(before), (command) =>
						Arr.join(command, " ")
					)
				).toContain(
					commandLine(
						deleteAfterExit({ folder: windowsFolder, pid: process.pid })
					)
				);
				expect(output).toContain(
					`mx uninstall deletes ${windowsFolder} once it exits.`
				);
				expect(output).not.toContain("Could not delete");
			})
		));
});
