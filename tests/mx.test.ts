import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it, mock } from "bun:test";
import { userInfo } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
	Array as Arr,
	type Cause,
	Config,
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
	Order,
	Path,
	PlatformError,
	Queue,
	Record as Rec,
	Scheduler,
	Schema,
	Terminal,
} from "effect";
import { Command } from "effect/cli";
import type { ChildProcess } from "effect/process";
import { SqlClient } from "effect/sql";
import { TestClock, TestConsole } from "effect/testing";
import packageJson from "../package.json" with { type: "json" };
import { savedConfig } from "../src/auth/config.ts";
import { mx, run as runMx } from "../src/cli.ts";
import { Paths } from "../src/paths.ts";
import { migrate, migrations } from "../src/store/migrations.ts";
import {
	deleteAfterExit,
	readUserPath,
	stopSync,
	writeUserPath,
} from "../src/windows.ts";
import {
	FakeMicrosoft,
	inlineImage,
	loginHost,
	uploadOrigin,
	userCode,
	verificationUri,
} from "./fake-microsoft.ts";
import { FakeProcesses } from "./fake-processes.ts";
import {
	FakeReleases,
	isReleaseRequest,
	releasesPath,
} from "./fake-releases.ts";
import { FakeSecrets } from "./fake-secrets.ts";
import { connect, McpClient, spawnClient } from "./mcp-client.ts";

/** The temporary home every XDG directory sits in. */
class Home extends Context.Service<Home, string>()("mx/tests/mx.test/Home") {}

const releases = await FakeReleases.make();
// mx trusts only the release key it imports; the tests sign their releases with a throwaway key instead.
mock.module("../release/public-key.pem", () => ({
	default: releases.publicKey,
}));

/** Whether mx is the only process attached to its console, as when Explorer starts it on a double-click. */
let consoleOwned = false;
// mx asks Windows through bun:ffi; the tests answer for it.
const windowsModule = await import("../src/windows.ts");
mock.module("../src/windows.ts", () => ({
	...windowsModule,
	ownsConsole: Effect.sync(() => consoleOwned),
}));

/** The version this checkout builds, and the releases above it. */
const running = packageJson.version;
const [major, minor] = running.split(".");
const later = (step: number) => `${major}.${Number(minor) + step}.0`;
const microsoft = new FakeMicrosoft(releases);
const processes = new FakeProcesses(microsoft.tunnels);
/** The system's secret store, which the fake below stands in for except in the test of the system's own. */
const systemSecrets = Bun.secrets;
const secrets = new FakeSecrets();
secrets.install();

/** The systems the tests run on; a test of what only some of them have runs there alone. */
type OperatingSystem = "darwin" | "linux" | "win32";
const os: OperatingSystem =
	process.platform === "darwin" || process.platform === "win32"
		? process.platform
		: "linux";
const windows = os === "win32";
const mac = os === "darwin";

/** The binary `bun run build <platform>` cross-compiles for macOS or Windows; CI builds it on Linux. */
const built = mac
	? {
			file: `${import.meta.dir}/../dist/mx-darwin-${process.arch}`,
			platform: `darwin-${process.arch}`,
		}
	: {
			file: `${import.meta.dir}/../dist/mx-windows-x64.exe`,
			platform: "windows-x64",
		};
/** The value for the system the tests run on. */
const onThisSystem = <A>(values: Record<OperatingSystem, A>) => values[os];

const machine = ManagedRuntime.make(
	Layer.effect(
		Home,
		Effect.flatMap(FileSystem.FileSystem, (fs) =>
			fs.makeTempDirectoryScoped({ prefix: "mx-test-" })
		)
	).pipe(Layer.provideMerge(BunServices.layer))
);
const home = await machine.runPromise(Home);
const { dirname, join } = await machine.runPromise(Path.Path);

/** The client id the tests sign in with, and another one, and the tenant. */
const clientId = "11111111-2222-4333-8444-555555555555";
const otherClientId = "66666666-7777-4888-9999-000000000000";
const tenant = "contoso.com";

/** The cloudflared `MX_CLOUDFLARED` names; the fake processes run it as a quick tunnel. */
const cloudflared = join(home, "bin", "cloudflared");

/** The environment of an mx process: its folders under the test home, cloudflared, a client id and a tenant. */
const environment = {
	APPDATA: join(home, "AppData", "Roaming"),
	HOME: home,
	LOCALAPPDATA: join(home, "AppData", "Local"),
	MX_CLIENT_ID: clientId,
	MX_CLOUDFLARED: cloudflared,
	MX_TENANT: tenant,
	PATH: join(home, "path"),
	USERPROFILE: home,
	XDG_CACHE_HOME: join(home, "cache"),
	XDG_CONFIG_HOME: join(home, "config"),
	XDG_DATA_HOME: join(home, "data"),
	XDG_STATE_HOME: join(home, "state"),
};

/** Windows opens no socket in a process without SystemRoot, so a process the tests start keeps it. */
const systemRoot = await machine.runPromise(
	Config.option(Config.NonEmptyString("SystemRoot"))
);

/** `environment` without `MX_CLIENT_ID` and `MX_TENANT`, where only config.json can name a client id and a tenant. */
const unconfiguredEnvironment = Rec.remove(
	Rec.remove(environment, "MX_CLIENT_ID"),
	"MX_TENANT"
);

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

const unconfigured = platformWith(unconfiguredEnvironment);

/** `mx mcp` as Claude Code starts it, one process for every test, with a client on its stdio. */
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

/**
 * How long a test may run. Bun's own limit fails a test but leaves its effect running, with `process.platform` still
 * faked for the tests after it, so mx's runtime interrupts the test at this one and its finalizers run first; Bun's,
 * at twice this, is the backstop for a test that its interruption does not stop.
 */
const testTimeout = Duration.seconds(30);

/**
 * One test, on mx's own runtime. A test of what only some systems have names them in `only`; elsewhere the test is
 * skipped, and its name says why.
 */
const test = <E>(
	name: string,
	body: () => Effect.Effect<
		void,
		E,
		Layer.Success<typeof platform> | McpClient
	>,
	only?: {
		readonly because: string;
		readonly systems: readonly OperatingSystem[];
	}
) => {
	const skipped = only !== undefined && !only.systems.includes(os);
	return it.skipIf(skipped)(
		skipped ? `${name} (skipped: ${only.because})` : name,
		() => server.runPromise(Effect.timeout(body(), testTimeout)),
		Duration.toMillis(Duration.times(testTimeout, 2))
	);
};

/** Everything any mx process printed, to check that no token ever shows. */
const printed: string[] = [];

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
					({ errors, output }) => {
						printed.push(...Arr.map([...errors, ...output], String));
						return {
							errors: Arr.join(Arr.map(errors, String), "\n"),
							exit,
							output: Arr.join(Arr.map(output, String), "\n"),
						};
					}
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
const status = run("status");

/** Runs `effect` with `stream` a terminal or not, as mx reads it from `isTTY`. */
const withTerminalOn =
	(stream: NodeJS.ReadStream | NodeJS.WriteStream) =>
	(isTTY: boolean) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const before = Object.getOwnPropertyDescriptor(stream, "isTTY");
				Object.defineProperty(stream, "isTTY", {
					configurable: true,
					value: isTTY,
				});
				return before;
			}),
			() => effect,
			(before) =>
				Effect.sync(() => {
					if (before === undefined) {
						Reflect.deleteProperty(stream, "isTTY");
					} else {
						Object.defineProperty(stream, "isTTY", before);
					}
				})
		);

/** mx asks for what a command needs only when stdin is a terminal. */
const withStdinTerminal = withTerminalOn(process.stdin);
/** A bare mx plays its banner only when stdout is a terminal. */
const withStdoutTerminal = withTerminalOn(process.stdout);
// bun test run in a terminal hands it stdin, so mx's stdin is a terminal only in a test that says so.
Object.defineProperty(process.stdin, "isTTY", {
	configurable: true,
	value: false,
});

/** A key of one character types it, and a longer one, such as `return`, presses the key of that name. */
const keyPress = (name: string): Terminal.UserInput => ({
	input: name.length === 1 ? Option.some(name) : Option.none(),
	key: { ctrl: false, meta: false, name, shift: false },
});

/**
 * `system` on a terminal where the user presses `keys` in turn, across every prompt, `press` presses one more once mx
 * reads the terminal, and `close` ends its input, as when stdin closes. `reading` answers whether mx has read the
 * terminal, and `frames` keeps everything mx drew on it.
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
					yield* Queue.offerAll(input, Arr.map(keys, keyPress));
				}
				return input;
			}),
			readLine: Effect.die("mx reads no lines from the terminal."),
			rows: Effect.succeed(24),
		})
	);
	const read = Effect.suspend(() =>
		input === undefined
			? Effect.die("mx has not read the terminal.")
			: Effect.succeed(input)
	);
	return {
		close: Effect.flatMap(read, Queue.end),
		frames,
		press: (name: string) =>
			Effect.flatMap(read, (queue) => Queue.offer(queue, keyPress(name))),
		reading: () => input !== undefined,
		system: Layer.merge(system, terminal),
	};
};

/** Runs `effect` as if on `system`; mx reads `process.platform` as it builds its layers. */
const asIfOn =
	(system: OperatingSystem) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const actual = process.platform;
				Object.defineProperty(process, "platform", { value: system });
				return actual;
			}),
			() => effect,
			(actual) =>
				Effect.sync(() => {
					Object.defineProperty(process, "platform", { value: actual });
				})
		);
const onWindows = asIfOn("win32");
const onMac = asIfOn("darwin");
const onLinux = asIfOn("linux");

/** Runs `effect` as if Explorer started mx on a double-click: on Windows, alone on a console of its own. */
const doubleClicked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			consoleOwned = true;
		}),
		() => effect,
		() =>
			Effect.sync(() => {
				consoleOwned = false;
			})
	).pipe(withStdoutTerminal(true), withStdinTerminal(true), onWindows);

/** Where the Arch package installs mx. */
const packaged = "/usr/bin/mx";

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

/** Runs `effect` as if mx ran from the Arch package's binary. */
const fromPackage = runningAs(packaged);

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

/**
 * `platform` where the exes in `inUse` run, as the mx mcp an agent started runs mx.exe. Windows renames a running exe,
 * which runs on under its new name, but deletes none; Effect reads its refusal as Unknown.
 */
const whileRunning = (inUse: Set<string>) =>
	Layer.merge(
		platform,
		Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (fs) =>
				FileSystem.FileSystem.of({
					...fs,
					remove: (path, options) =>
						inUse.has(path)
							? Effect.fail(
									PlatformError.systemError({
										_tag: "Unknown",
										method: "remove",
										module: "FileSystem",
										pathOrDescriptor: path,
									})
								)
							: fs.remove(path, options),
					rename: (from, to) =>
						Effect.tap(fs.rename(from, to), () =>
							Effect.sync(() => {
								if (inUse.delete(from)) {
									inUse.add(to);
								}
							})
						),
				})
			)
		).pipe(Layer.provide(BunServices.layer))
	);

/** `platform` where an agent saves its config, as `save` does, while mx install writes the binary. */
const savedWhileInstalling = (
	save: (
		fs: FileSystem.FileSystem
	) => ReturnType<FileSystem.FileSystem["writeFile"]>
) =>
	Layer.merge(
		platform,
		Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (fs) =>
				FileSystem.FileSystem.of({
					...fs,
					writeFile: (file, data, options) =>
						file.startsWith(dirname(installed))
							? Effect.andThen(save(fs), fs.writeFile(file, data, options))
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

/** The sha256 of `bytes` in hex. Tests compare binaries by it, so a mismatch prints one line instead of every byte. */
const sha256 = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** The sha256 of the bytes in `file`. */
const fileSha256 = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.map(fs.readFile(file), sha256)
	);

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

/** Where mx keeps its files: below `%LOCALAPPDATA%\\mx` on Windows, below `~/Library` on macOS, in the XDG folders on Linux. */
const local = join(home, "AppData", "Local", "mx");
const library = join(home, "Library");
const support = join(library, "Application Support", "mx");
const { cacheFolder, configFile, dataFolder, stateFolder } = onThisSystem({
	darwin: {
		cacheFolder: join(library, "Caches", "mx"),
		configFile: join(support, "config.json"),
		dataFolder: join(support, "data"),
		stateFolder: join(library, "Logs", "mx"),
	},
	linux: {
		cacheFolder: join(home, "cache", "mx"),
		configFile: join(home, "config", "mx", "config.json"),
		dataFolder: join(home, "data", "mx"),
		stateFolder: join(home, "state", "mx"),
	},
	win32: {
		cacheFolder: join(local, "cache"),
		configFile: join(local, "config.json"),
		dataFolder: join(local, "data"),
		stateFolder: join(local, "state"),
	},
});
const tokenFile = join(stateFolder, "refresh-token");
/** The sign-in's entry in the system's secret store. */
const credential = { name: "refresh-token", service: "mx" };

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
const settleBriefly = Effect.promise(() => Bun.sleep(100));

const deltaRequests = (folderId: string) =>
	Arr.filter(graphRequests("/messages/delta"), (request) =>
		request.url.pathname.includes(`/${folderId}/`)
	).length;

/** The requests that listed the ids of the messages in a folder. */
const idListings = () =>
	Arr.filter(microsoft.graphRequests(), (request) =>
		idListingPath.test(request.url.pathname)
	);
const inboxIdListings = () =>
	Arr.filter(idListings(), (request) =>
		request.url.pathname.includes("/folder-inbox/")
	).length;

const allFolders = [
	"folder-inbox",
	"folder-projects",
	"folder-sent",
	"folder-drafts",
	"folder-deleted",
	"folder-archive",
];

/** Where mx install puts the binary on Windows: mx.exe, and its copy mxw.exe that runs `mx sync`. */
const windowsFolder = join(home, "AppData", "Local", "Programs", "mx");
const background = join(windowsFolder, "mxw.exe");
const installed = windows
	? join(windowsFolder, "mx.exe")
	: join(home, ".local", "bin", "mx");

/** Where an exe keeps its PE optional header's Subsystem, which tells Windows whether it is a console or a GUI program. */
const subsystemAt = (exe: Uint8Array) =>
	new DataView(exe.buffer, exe.byteOffset).getUint32(0x3c, true) + 4 + 20 + 68;
const subsystem = (exe: Uint8Array) =>
	new DataView(exe.buffer, exe.byteOffset).getUint16(subsystemAt(exe), true);
const consoleSubsystem = 3;
const guiSubsystem = 2;

/** A binary with a PE header, as mx reads one when it writes mxw.exe on Windows, and `label` after it. */
const syntheticExe = (label: string) => {
	const exe = new Uint8Array(0x2_00);
	const view = new DataView(exe.buffer);
	view.setUint32(0x3c, 0x80, true);
	exe.set(new TextEncoder().encode("PE\0\0"), 0x80);
	view.setUint16(subsystemAt(exe), consoleSubsystem, true);
	exe.set(new TextEncoder().encode(label), 0x1_00);
	return exe;
};
const newBinary = syntheticExe(`synthetic mx ${later(1)} binary`);
const otherBinary = syntheticExe("synthetic binary nobody released");

/** How often mx downloaded the binary of `version`. */
const downloads = (version: string) =>
	Arr.filter(microsoft.received, (request) =>
		request.url.pathname.startsWith(`${releasesPath}download/v${version}/`)
	).length;
const unitFile = join(home, "config", "systemd", "user", "mx-sync.service");
const mxEntry = { args: ["mcp"], command: installed };

/** The LaunchAgent that runs `mx sync` on macOS, and launchd's names for the user's GUI session and for the agent in it. */
const agentLabel = "io.github.pixelhabits.mx.sync";
const agentFile = join(home, "Library", "LaunchAgents", `${agentLabel}.plist`);
const agentDomain = `gui/${userInfo().uid}`;
const agentTarget = `${agentDomain}/${agentLabel}`;

/**
 * What mx uninstall deletes: the binary, the background copy, unit or LaunchAgent that runs `mx sync`, and each of mx's
 * folders.
 */
const mxFiles = [
	installed,
	onThisSystem({ darwin: agentFile, linux: unitFile, win32: background }),
	configFile,
	dataFolder,
	cacheFolder,
	stateFolder,
];

const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** A command as `processes.commands` records it, joined by spaces. */
const commandLine = (command: ChildProcess.StandardCommand) =>
	Arr.join([command.command, ...command.args], " ");
const stopBackground = commandLine(stopSync(process.pid));

/**
 * The programs mx runs to register, restart and remove the background `mx sync`, and to ask whether it is registered:
 * systemd on Linux; launchd on macOS, where `start` loads the agent that `restart` finds unloaded, and `reload`, after
 * mx install, unloads the agent and loads it again once launchd has removed it; on Windows the Run key, and the user
 * PATH that holds the program folder.
 */
const syncCommands = onThisSystem({
	darwin: {
		register: [],
		registered: [],
		reload: [
			`launchctl bootout ${agentTarget}`,
			`launchctl print ${agentTarget}`,
			`launchctl bootstrap ${agentDomain} ${agentFile}`,
		],
		remove: [`launchctl bootout ${agentTarget}`],
		restart: [`launchctl kickstart -k ${agentTarget}`],
		start: [
			`launchctl kickstart -k ${agentTarget}`,
			`launchctl bootstrap ${agentDomain} ${agentFile}`,
		],
	},
	linux: {
		register: [
			"systemctl --user daemon-reload",
			"systemctl --user enable mx-sync.service",
		],
		registered: ["systemctl --user is-enabled --quiet mx-sync.service"],
		reload: ["systemctl --user restart --no-block mx-sync.service"],
		remove: [
			"systemctl --user disable --now mx-sync.service",
			"systemctl --user daemon-reload",
		],
		restart: ["systemctl --user restart --no-block mx-sync.service"],
		start: ["systemctl --user restart --no-block mx-sync.service"],
	},
	win32: {
		register: [
			commandLine(readUserPath),
			`reg add ${runKey} /v mx /t REG_SZ /d "${background}" sync /f`,
		],
		registered: [`reg query ${runKey} /v mx`],
		reload: [stopBackground, `${background} sync`],
		remove: [
			stopBackground,
			`reg delete ${runKey} /v mx /f`,
			commandLine(readUserPath),
			commandLine(writeUserPath("")),
		],
		restart: [stopBackground, `${background} sync`],
		start: [stopBackground, `${background} sync`],
	},
});

/** The programs that open a URL in the browser on Linux, macOS and Windows. */
const browsers = new Set(["xdg-open", "open", "rundll32.exe"]);
/** Those, and the programs that copy text to the clipboard. */
const desktopPrograms = new Set([
	...browsers,
	"wl-copy",
	"xclip",
	"xsel",
	"pbcopy",
	"clip.exe",
]);
/** Every program works again. */
const restorePrograms = Effect.sync(() => {
	processes.missing.clear();
	processes.failing.clear();
	processes.hanging.clear();
});

/** The agents mx offers here, as `--agent` names them; Claude Desktop only on Windows and macOS. */
const offeredAgents =
	windows || mac ? "claude-desktop, claude-code, codex" : "claude-code, codex";

const claudeCodeConfig = join(home, ".claude.json");
const claudeCodeSettings = {
	mcpServers: {
		mx: { args: ["mcp"], command: "/old/mx", env: { MX_DEBUG: "1" } },
		other: { args: [], command: "other" },
	},
	numStartups: 3,
	projects: { [home]: { allowedTools: [] } },
};

const desktopConfig = join(
	home,
	"AppData",
	"Roaming",
	"Claude",
	"claude_desktop_config.json"
);

const codexConfig = join(home, ".codex", "config.toml");
/** The `command` line of `[mcp_servers.mx]`, with the installed binary quoted as TOML quotes it. */
const codexCommand = Bun.TOML.stringify({ command: installed }).trim();
const codexSettings = `# Codex settings for the test machine.
model = "gpt-6.1-sol"

[mcp_servers.mx]
command = "/old/mx"
args = ["mcp"]

[mcp_servers.mx.env]
MX_DEBUG = "1"

# A server mx leaves alone.
[mcp_servers.other]
command = "other"
`;
/** `[mcp_servers.mx.tools.<tool>]` tables, each with its approval mode. */
const codexApprovals = (approvals: readonly (readonly [string, string])[]) =>
	Arr.join(
		Arr.map(
			approvals,
			([name, mode]) =>
				`[mcp_servers.mx.tools.${name}]\napproval_mode = "${mode}"\n\n`
		),
		""
	);
/** The recommended approvals: every tool runs without asking, except send, delete and delete_folder, which always ask. */
const recommended = [
	["search", "approve"],
	["query", "approve"],
	["thread", "approve"],
	["message", "approve"],
	["attachment", "approve"],
	["draft", "approve"],
	["update_draft", "approve"],
	["delete_draft", "approve"],
	["send", "prompt"],
	["update", "approve"],
	["delete", "prompt"],
	["folder", "approve"],
	["delete_folder", "prompt"],
] as const;
const codexWithMx = `# Codex settings for the test machine.
model = "gpt-6.1-sol"

[mcp_servers.mx]
${codexCommand}
args = ["mcp"]

[mcp_servers.mx.env]
MX_DEBUG = "1"

${codexApprovals(recommended)}# A server mx leaves alone.
[mcp_servers.other]
command = "other"
`;
/** `codexSettings` where the user already lets Codex run `send` without asking. */
const codexSendApproved = codexSettings.replace(
	"# A server mx leaves alone.",
	`${codexApprovals([["send", "approve"]])}# A server mx leaves alone.`
);

/** Claude Code's user settings, linked into a dotfiles folder, where the user denies mx's `delete`. */
const claudeCodeSettingsFile = join(home, ".claude", "settings.json");
const dotfile = join(home, "dotfiles", "claude", "settings.json");
const userSettings = {
	model: "opus",
	permissions: { allow: ["Bash(ls *)"], deny: ["mcp__mx__delete"] },
};

const codexWithoutMx = `# Codex settings for the test machine.
model = "gpt-6.1-sol"

# A server mx leaves alone.
[mcp_servers.other]
command = "other"
`;

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
const writeJson = (file: string, value: unknown) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.writeFileString(file, JSON.stringify(value, null, 2))
	);

/**
 * `platform` on a machine where mx never synced: a store of its own, and Claude Code's config in a folder of its own,
 * since on Windows the store sits below the same folder as the installed program, and on macOS below the home folder.
 */
const neverSynced = (name: string) =>
	Effect.gen(function* () {
		const root = join(home, name);
		const claude = join(root, "claude");
		yield* (yield* FileSystem.FileSystem).makeDirectory(claude, {
			recursive: true,
		});
		yield* writeJson(join(claude, ".claude.json"), { numStartups: 1 });
		return platformWith({
			...environment,
			CLAUDE_CONFIG_DIR: claude,
			HOME: root,
			LOCALAPPDATA: join(root, "Local"),
			XDG_DATA_HOME: join(root, "data"),
		});
	});

/** `platform` on a machine of its own below `name`, and where mx keeps the mail store there. */
const ownStore = (name: string) => {
	const root = join(home, name);
	return {
		database: onThisSystem({
			darwin: join(
				root,
				"Library",
				"Application Support",
				"mx",
				"data",
				"mx.sqlite"
			),
			linux: join(root, "data", "mx", "mx.sqlite"),
			win32: join(root, "Local", "mx", "data", "mx.sqlite"),
		}),
		system: platformWith({
			...environment,
			HOME: root,
			LOCALAPPDATA: join(root, "Local"),
			XDG_DATA_HOME: join(root, "data"),
		}),
	};
};

/** The schema that mx 0.1.0 created at every start, before the store recorded its migrations. */
const schemaBeforeMigrations = `
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
CREATE TABLE IF NOT EXISTS local_ids (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	graph_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS lookups (
	graph_id TEXT PRIMARY KEY,
	asked INTEGER NOT NULL,
	filed INTEGER NOT NULL
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
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (subject, sender, body, tokenize = 'porter unicode61 remove_diacritics 2');
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
CREATE TABLE IF NOT EXISTS heartbeat (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	written_at INTEGER NOT NULL,
	last_success_at INTEGER,
	mode TEXT NOT NULL,
	version TEXT NOT NULL,
	last_error TEXT
);
`;

/** Runs `use` on the SQLite database `file`, as another program that opens mx's store would. */
const withDatabase = <A>(file: string, use: (db: Database) => A) =>
	Effect.acquireUseRelease(
		Effect.sync(() => new Database(file, { strict: true })),
		(db) => Effect.sync(() => use(db)),
		(db) => Effect.sync(() => db.close())
	);

/** The migrations the store at `file` records, oldest first. */
const recordedMigrations = (file: string) =>
	withDatabase(file, (db) =>
		db
			.query(
				"SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id"
			)
			.all()
	);

/** Runs `effect` on the SQLite database `file` through Effect's SqlClient, as the store does. */
const onStore =
	(file: string) =>
	<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
		// @effect-diagnostics-next-line strictEffectProvide:off - one connection to the store, as one mx process opens it.
		Effect.provide(effect, SqliteClient.layer({ filename: file }));

/**
 * A migration after the ones this mx knows, as a newer mx brings: it clears every folder's delta link, as a migration
 * may, so the next pass reads each folder from the start.
 */
const laterMigration = {
	"0002_resync_every_folder": Effect.flatMap(SqlClient.SqlClient, (sql) =>
		Effect.asVoid(sql`UPDATE folders SET delta_link = NULL`)
	),
};

/** The log every mx process writes its tool calls, prompts and sync lines to, and the most live data it may hold. */
const logFile = join(stateFolder, "log.sqlite");
const logCap = 50 * 1024 * 1024;

/** The bytes of the pages SQLite uses in the database `db`, leaving out the free pages it reuses. */
const liveBytes = (db: Database) =>
	db
		.query<{ bytes: number }, []>(
			"SELECT (page_count - freelist_count) * page_size AS bytes FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()"
		)
		.get()?.bytes ?? 0;

/** The rows `mx log --json` prints with `args` on `system`, decoded. */
const loggedRowsOn =
	(system: typeof platform) =>
	(...args: string[]) =>
		Effect.flatMap(cliOn(system)("log", "--json", ...args), ({ output }) =>
			Effect.forEach(
				Arr.filter(lines(output), (line) => line !== ""),
				parseJson
			)
		);
const loggedRows = loggedRowsOn(platform);

const instantText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

/** A logged tool call or prompt of the test client in this process, with `fields`. */
const loggedCall = (fields: Record<string, unknown>) => ({
	agent: { name: "mx-test", version: "1.0.0" },
	at: expect.stringMatching(instantText),
	durationMs: expect.any(Number),
	id: expect.any(Number),
	pid: process.pid,
	...fields,
});

/** The lines `mx log` prints for one call: its header, then what the agent sent and the whole answer, indented. */
const loggedText = (header: string, sent: string, answer: string) => {
	const [first = "", ...rest] = lines(answer);
	return [
		header,
		`  arguments: ${sent}`,
		`  result: ${first}`,
		...Arr.map(rest, (line) => `    ${line}`),
	];
};

/** The messages Graph holds in every folder now. */
const mailboxSize = () =>
	Arr.reduce(
		allFolders,
		0,
		(total, folder) => total + microsoft.inFolder(folder).length
	);

/** Runs `effect` on the test clock, which moves on 10 seconds whenever the work has waited a moment of real time. */
const onTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.raceFirst(
		effect,
		Effect.forever(
			Effect.andThen(settleBriefly, TestClock.adjust("10 seconds"))
		)
	).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one mx process runs on.
		Effect.provide(TestClock.layer())
	);

/** Microsoft accepts refresh tokens again. */
const acceptRefresh = Effect.sync(() => {
	microsoft.refuseRefresh = false;
});

/** Graph answers delta pages at once again, and no program start is watched. */
const paceAsBefore = Effect.sync(() => {
	microsoft.deltaDelay = Duration.zero;
	processes.onSpawn = undefined;
});
const secrets_ = /synthetic-(access|refresh)-token|synthetic-device-code/u;
const ownSentLine = /^#\d+ .* Sent Items \(me\)$/mu;
const imageLine = /^1 image001\.png .*inline\)$/u;
const sheetLine = /^2 budget\.xls /u;
const earlyDraftLine =
	/^#\d+ .* Drafts \| to bob@example\.test \| Before sync \| draft$/u;
const replyDraftLine = /^#\d+ .* Drafts \| to Carol Example/u;
const permanent = /permanentDelete/u;
const runningLine = /^mx sync: running, last heard from \d+ s ago$/u;
const lastSyncLine = /^Last sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, \d+ s ago$/u;
/** The line mx sync logs as it starts, when push comes up or cannot. */
const pushModeLine = /^Push is (up through|unavailable:) /u;
const loopbackUrl = /^http:\/\/127\.0\.0\.1:\d+$/u;
const loopbackAddress = /^127\.0\.0\.1:\d+$/u;
const aliceLatestLine =
	/^#\d+ .* \| Alice Example <alice@example\.test> \| RE: Quarterly budget \| unread \(\+2 in thread\)$/u;
const bookClubLine =
	/ \| Priya Example <priya@example\.com> \| Book club: the next novel \| unread \(\+1 in thread\)$/u;
const bookClubReplyLine =
	/ \| Jonas Example <jonas@example\.com> \| RE: Book club: the next novel \| unread \(\+1 in thread\)$/u;
const recipeSwapLine = /Recipe swap \| unread \(\+3 in thread\)$/u;
const idListingPath = /^\/v1\.0\/me\/mailFolders\/[^/]+\/messages$/u;
const seedOrderLine = /^#2 .* \| Garden supplies order \| unread$/mu;
const rotaInArchiveLine =
	/ Archive \| Rosa Example <rosa@example\.com> \| Garden plot rota /u;
const beanPolesInInboxLine =
	/ Inbox \| Rosa Example <rosa@example\.com> \| Bean poles /u;
const trellisWireLine =
	/ Trellis \| Rosa Example <rosa@example\.com> \| Trellis wire /u;
const timeLeft = /, (about \d+ min|less than a minute) left/u;
const cutAtCharacters =
	/^\(first \d+ rows, cut at 20000 characters; refine the query\)$/u;
/** The link that opens Carol's lunch message in Outlook on the web, as Graph's webLink gives it. */
const lunchLink =
	"https://outlook.cloud.microsoft/mail/deeplink?ItemID=AAkALgAAAAAASyNtHeTiCmAiLbOxIdAC%2FEWg0ASyNtHeTiC%2BiD0000TeStMaIlBoX0AA&exvsurl=1&viewmodel=ReadMessageItem";
const outlookLine = /^Open in Outlook: https:\/\/\S+$/gmu;
const lineIn = (id: number, folder: string) =>
	new RegExp(`^#${id} .* ${folder} \\|`, "u");

/** The people and the notifier of the synthetic mail the tests add. */
const jonas = { address: "jonas@example.com", name: "Jonas Example" };
const marta = { address: "marta@example.com", name: "Marta Example" };
const priya = { address: "priya@example.com", name: "Priya Example" };
const rosa = { address: "rosa@example.com", name: "Rosa Example" };
const alerts = { address: "alerts@example.com", name: "Backup Notifier" };

/** A nightly backup that failed, by the day of October it failed and the share it backed up. */
const nightlyBackups = [
	["08", "photos"],
	["09", "documents"],
	["10", "music"],
] as const;

const tools = [
	"attachment",
	"delete",
	"delete_draft",
	"delete_folder",
	"draft",
	"folder",
	"message",
	"query",
	"search",
	"send",
	"thread",
	"update",
	"update_draft",
];

describe("mx", () => {
	test("a bare mx without a terminal on stdout prints the help and no banner", () =>
		Effect.gen(function* () {
			const { frames, system } = fakeTerminal(platform, []);
			const { errors, output } = yield* withStdoutTerminal(false)(
				runOn(system)()
			);
			expect(frames).toEqual([]);
			expect(output).toContain("SUBCOMMANDS");
			expect(output).not.toContain("inbox");
			expect(errors).toBe("");
		}));

	test("a bare mx on a terminal plays the banner, leaves its last frame above the help and shows the cursor again", () =>
		Effect.gen(function* () {
			const { frames, system } = fakeTerminal(
				platformWith({ ...environment, NO_COLOR: "1" }),
				[]
			);
			const { output } = yield* withStdoutTerminal(true)(runOn(system)());
			expect(frames.length).toBeGreaterThan(10);
			expect(frames[0]).toStartWith("\u001b[?25l");
			expect(frames.at(-1)).toBe("\u001b[?25h");
			const banner = Arr.join(
				[
					"  ┌───────┐                          ┌───────┐",
					"  │╲     ╱│      ✉ ─ ─ ─ ─ ─ ─►      │  ▤▤▤  │",
					"  │  ╲ ╱  │      ◄─ ─ ─ ─ ─ ─ ✉      │ inbox │",
					"  └───────┘                          └───────┘",
					"                      mx",
				],
				"\n"
			);
			// Windows draws the envelope, the tray and the flap in code page 437 glyphs.
			expect(frames.at(-2)).toContain(
				windows
					? banner
							.replaceAll("✉", "≡")
							.replaceAll("▤", "≡")
							.replaceAll("╲", "\\")
							.replaceAll("╱", "/")
					: banner
			);
			expect(output).toContain("SUBCOMMANDS");
		}));

	test("on Windows, a bare mx run in a terminal plays the banner, prints the help and installs nothing", () =>
		Effect.gen(function* () {
			const { frames, system } = fakeTerminal(platform, []);
			const before = processes.commands.length;
			const { output } = yield* runOn(system)().pipe(
				withStdoutTerminal(true),
				onWindows
			);
			expect(frames[0]).toStartWith("\u001b[?25l");
			expect(output).toContain("SUBCOMMANDS");
			expect(processes.commands).toHaveLength(before);
		}));

	test("mx mcp on a terminal writes nothing but MCP messages to stdout", () =>
		Effect.gen(function* () {
			const { frames, system } = fakeTerminal(platform, []);
			const listed = yield* withStdoutTerminal(true)(
				Effect.gen(function* () {
					const { client, stdio } = yield* connect();
					yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
						// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
						Effect.provide(stdio),
						// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
						Effect.provide(system, { local: true }),
						Effect.forkScoped
					);
					return yield* client.request("tools/list");
				}).pipe(Effect.scoped)
			);
			expect(listed).toMatchObject({ tools: expect.any(Array) });
			expect(frames).toEqual([]);
		}));

	test("mx mcp speaks MCP 2026-07-28, then the 2025-11-25 and 2025-06-18 handshakes, and lists the thirteen tools, marking reads read-only and every write but draft destructive", () =>
		Effect.gen(function* () {
			const client = yield* McpClient;
			expect(yield* client.request("server/discover")).toMatchObject({
				supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
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
				delete_folder: "write destructive",
				draft: "write safe",
				folder: "write destructive",
				message: "read safe",
				query: "read safe",
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

	for (const [version, sender] of [
		["2025-11-25", "Claude Desktop"],
		["2025-06-18", "Codex"],
	] as const) {
		test(`mx mcp answers the initialize at MCP ${version} that ${sender} opens with, then lists the tools and prompts it lists on 2026-07-28 and answers them`, () =>
			Effect.gen(function* () {
				const modern = yield* McpClient;
				const { client, stdio } = yield* connect(version);
				yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
					// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
					Effect.provide(stdio),
					// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
					Effect.provide(platform, { local: true }),
					Effect.forkScoped
				);
				const initialized = yield* client.initialize;
				const discovered = (yield* modern.request("server/discover")) as {
					instructions: string;
				};
				expect(initialized.protocolVersion).toBe(version);
				expect(initialized.serverInfo.name).toBe("mx");
				expect(initialized.instructions).toBe(discovered.instructions);
				const list = Effect.fnUntraced(function* (
					from: typeof client,
					what: "prompts" | "tools"
				) {
					const listed = (yield* from.request(`${what}/list`)) as Record<
						typeof what,
						{ name: string }[]
					>;
					return listed[what];
				});
				const listed = yield* list(client, "tools");
				expect(Arr.map(listed, ({ name }) => name).sort()).toEqual(tools);
				expect(listed).toEqual(yield* list(modern, "tools"));
				expect(yield* list(client, "prompts")).toEqual(
					yield* list(modern, "prompts")
				);
				const counted = yield* client.call("query", { sql: "SELECT 1 AS one" });
				expect(counted.isError).toBe(false);
				expect(lines(counted.text).slice(-2)).toEqual(["one", "1"]);
				const text = yield* client.prompt("triage", { since: "2026-10-01" });
				expect(lines(text)[0]).toBe(
					"Triage the user's mail received since 2026-10-01."
				);
			}).pipe(Effect.scoped));
	}

	test("mx mcp never agrees to MCP 2025-03-26, which no client sends: it answers an initialize at it with 2025-11-25", () =>
		Effect.gen(function* () {
			const { client, stdio } = yield* connect("2025-03-26");
			yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
				Effect.provide(stdio),
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
				Effect.provide(platform, { local: true }),
				Effect.forkScoped
			);
			expect((yield* client.initialize).protocolVersion).toBe("2025-11-25");
		}).pipe(Effect.scoped));

	test("mx mcp lists the triage prompt, which takes an optional since, and the interview prompt, which takes nothing", () =>
		Effect.gen(function* () {
			const client = yield* McpClient;
			expect(yield* client.request("prompts/list")).toMatchObject({
				prompts: [
					{
						arguments: [
							{
								description:
									"The first day of mail to triage, as YYYY-MM-DD; 7 days before today unless given.",
								name: "since",
								required: false,
							},
						],
						description: "Review new mail and report what needs the user",
						name: "triage",
					},
					{
						arguments: [],
						description:
							"Learn how the user handles mail, so triage follows it",
						name: "interview",
					},
				],
			});
		}));

	test("the triage prompt asks for the mail received since the date it is given", () =>
		Effect.gen(function* () {
			const client = yield* McpClient;
			const text = yield* client.prompt("triage", { since: "2026-10-01" });
			expect(lines(text)[0]).toBe(
				"Triage the user's mail received since 2026-10-01."
			);
			expect(text).toContain("folder Inbox, since 2026-10-01, no query");
		}));

	test("the triage prompt without a date asks for the mail of the 7 days before the user's today", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(
				Temporal.PlainDateTime.from("2026-01-05T12:00").toZonedDateTime(
					Temporal.Now.timeZoneId()
				).epochMilliseconds
			);
			const text = yield* Effect.gen(function* () {
				const { client, stdio } = yield* connect();
				yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
					// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
					Effect.provide(stdio),
					// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
					Effect.provide(platform, { local: true }),
					Effect.forkScoped
				);
				return yield* client.prompt("triage");
			}).pipe(Effect.scoped);
			expect(lines(text)[0]).toBe(
				"Triage the user's mail received since 2025-12-29."
			);
			expect(text).toContain("folder Inbox, since 2025-12-29, no query");
		}).pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one mx mcp process runs on.
			Effect.provide(TestClock.layer())
		));

	test("mx log --json shows each tool call and prompt an agent made, with the agent, what it sent, the whole answer, whether it failed and how long it took", () =>
		Effect.gen(function* () {
			const counted = yield* tool("query", { sql: "SELECT 'logged' AS call" });
			const missing = yield* refusal("thread", { id: 999_999 });
			const interview = yield* (yield* McpClient).prompt("interview");
			const rows = yield* loggedRows("--limit", "3");
			expect(rows).toEqual([
				loggedCall({
					arguments: { sql: "SELECT 'logged' AS call" },
					isError: false,
					kind: "tool",
					name: "query",
					result: counted,
				}),
				loggedCall({
					arguments: { id: 999_999 },
					isError: true,
					kind: "tool",
					name: "thread",
					result: missing,
				}),
				loggedCall({
					arguments: {},
					isError: false,
					kind: "prompt",
					name: "interview",
					result: interview,
				}),
			]);
			for (const row of rows) {
				const { durationMs } = row as { durationMs: number };
				expect(Number.isInteger(durationMs) && durationMs >= 0).toBe(true);
			}
		}));

	test("a tool answers even when mx cannot write its log, and mx mcp says on stderr that the log failed", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { client, stdio } = yield* connect();
			yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
				Effect.provide(stdio),
				Effect.forkScoped
			);
			yield* client.request("tools/list");
			const aside = `${logFile}.aside`;
			const answer = yield* Effect.acquireUseRelease(
				// A folder where the log should be is a file SQLite cannot open.
				Effect.andThen(fs.rename(logFile, aside), fs.makeDirectory(logFile)),
				() => client.call("query", { sql: "SELECT 'unlogged' AS call" }),
				() =>
					Effect.orDie(
						Effect.andThen(
							fs.remove(logFile, { recursive: true }),
							fs.rename(aside, logFile)
						)
					)
			);
			expect(answer.isError).toBe(false);
			expect(lines(answer.text).slice(-2)).toEqual(["call", "unlogged"]);
			const errors = Arr.map(yield* TestConsole.errorLines, String);
			expect(Arr.filter(errors, (line) => line.includes(logFile))).toHaveLength(
				1
			);
			const [newest] = yield* loggedRows("--limit", "1");
			expect(newest).not.toMatchObject({
				arguments: { sql: "SELECT 'unlogged' AS call" },
			});
		}).pipe(
			Effect.scoped,
			// @effect-diagnostics-next-line strictEffectProvide:off - the machine this mx mcp process and the test share, with one console.
			Effect.provide(platform, { local: true })
		));

	test("mx log prints each call in the local time zone with its agent, what it sent and the whole answer, oldest first; --tool, --since and --limit choose the rows", () =>
		Effect.gen(function* () {
			yield* tool("query", { sql: "SELECT 'before' AS call" });
			yield* Effect.promise(() => Bun.sleep(5));
			const since = Temporal.Now.instant();
			yield* Effect.promise(() => Bun.sleep(5));
			const second = yield* tool("query", { sql: "SELECT 'second' AS call" });
			yield* refusal("thread", { id: 999_999 });
			const third = yield* tool("query", { sql: "SELECT 'third' AS call" });
			const headers = Arr.map(
				yield* loggedRows("--tool", "query", "--limit", "2"),
				(row) => {
					const { at, durationMs } = row as { at: string; durationMs: number };
					const shown = Temporal.Instant.from(at)
						.toZonedDateTimeISO(Temporal.Now.timeZoneId())
						.toPlainDateTime()
						.toString({ smallestUnit: "second" })
						.replace("T", " ");
					return `${shown} mx-test 1.0.0 tool query (ok, ${durationMs} ms)`;
				}
			);
			const { output } = yield* cli(
				"log",
				"--tool",
				"query",
				"--since",
				since.toString()
			);
			expect(lines(output)).toEqual([
				...loggedText(
					headers[0] ?? "",
					`{"sql":"SELECT 'second' AS call"}`,
					second
				),
				...loggedText(
					headers[1] ?? "",
					`{"sql":"SELECT 'third' AS call"}`,
					third
				),
			]);
			const { output: newest } = yield* cli(
				"log",
				"--tool",
				"query",
				"--limit",
				"1"
			);
			expect(lines(newest)).toEqual(
				loggedText(headers[1] ?? "", `{"sql":"SELECT 'third' AS call"}`, third)
			);
			const tomorrow = Temporal.Now.plainDateISO().add({ days: 1 });
			const { output: none } = yield* cli(
				"log",
				"--since",
				tomorrow.toString()
			);
			expect(none).toBe("");
		}));

	test("mx log --follow prints each row written after it started", () =>
		Effect.gen(function* () {
			const following = yield* Effect.forkChild(
				runMx(["log", "--follow", "--tool", "query", "--limit", "1"])
			);
			const output = Effect.map(TestConsole.logLines, (logged) =>
				Arr.join(Arr.map(logged, String), "\n")
			);
			yield* eventually(
				"the newest query call",
				Effect.map(output, (text) => text !== "")
			);
			yield* tool("query", { sql: "SELECT 'followed' AS call" });
			yield* eventually(
				"the call made while mx log follows",
				Effect.map(output, (text) =>
					text.includes(`arguments: {"sql":"SELECT 'followed' AS call"}`)
				)
			);
			yield* Fiber.interrupt(following);
		}).pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off - the machine this mx log process and the test share, with one console.
			Effect.provide(platform, { local: true }),
			onTestClock
		));

	test("two mx mcp processes that write the log at the same time both land every row", () =>
		Effect.gen(function* () {
			const env = {
				...environment,
				// Nothing reaches Microsoft: every request goes to a closed port.
				HTTPS_PROXY: "http://127.0.0.1:9",
				...Rec.getSomes({ SystemRoot: systemRoot }),
			};
			const fromSource = [process.execPath, "--no-env-file", "src/main.ts"];
			const clients = yield* Effect.all([
				spawnClient(fromSource, env),
				spawnClient(fromSource, env),
			]);
			const sent = Arr.flatMap(clients, (client, index) =>
				Arr.map(Arr.range(1, 10), (n) => ({
					client,
					query: `process-${index}-call-${n}`,
				}))
			);
			yield* Effect.forEach(
				sent,
				({ client, query }) => client.call("search", { query }),
				{ concurrency: "unbounded" }
			);
			const rows = (yield* loggedRows(
				"--tool",
				"search",
				"--limit",
				String(sent.length)
			)) as readonly {
				arguments: { query: string };
				isError: boolean;
				pid: number;
			}[];
			expect(
				Arr.sort(
					Arr.map(rows, (row) => row.arguments.query),
					Order.String
				)
			).toEqual(
				Arr.sort(
					Arr.map(sent, ({ query }) => query),
					Order.String
				)
			);
			const pids = new Set(Arr.map(rows, (row) => row.pid));
			expect(pids.size).toBe(2);
			expect(pids.has(process.pid)).toBe(false);
		}).pipe(Effect.scoped));

	test("parallel tool calls through one mx mcp each land their row, and no answer waits on another call's write, however often Effect switches between the calls", () =>
		Effect.gen(function* () {
			const { client, stdio } = yield* connect();
			yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
				Effect.provide(stdio),
				// Each fiber lets the others run after 16 steps instead of Effect's default 2048, as the scheduler may after any step.
				Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
				Effect.forkScoped
			);
			const queries = Arr.map(Arr.range(1, 3), (n) => `parallel-call-${n}`);
			const started = Temporal.Now.instant();
			yield* Effect.forEach(
				queries,
				(query) =>
					Effect.flatMap(client.call("search", { query }), ({ isError }) =>
						isError ? Effect.die(`search ${query} failed.`) : Effect.void
					),
				{ concurrency: "unbounded" }
			);
			const took = Temporal.Now.instant().since(started);
			const rows = (yield* loggedRows(
				"--tool",
				"search",
				"--limit",
				String(queries.length)
			)) as readonly { arguments: { query: string } }[];
			expect(
				Arr.sort(
					Arr.map(rows, (row) => row.arguments.query),
					Order.String
				)
			).toEqual(Arr.sort(queries, Order.String));
			// SQLite's busy timeout, which a write waits out while another holds the log.
			expect(took.total("seconds")).toBeLessThan(5);
		}).pipe(
			Effect.scoped,
			// @effect-diagnostics-next-line strictEffectProvide:off - the machine this mx mcp process and the test share.
			Effect.provide(platform, { local: true })
		));

	test("the log keeps at most 50 MB of live data: after a call it deletes the oldest rows until it fits, and the newest rows stay", () =>
		Effect.gen(function* () {
			const seeds = 60;
			const megabyte = "x".repeat(1024 * 1024);
			yield* withDatabase(logFile, (db) => {
				const insert = db.prepare(
					"INSERT INTO entries (at, pid, kind, name, arguments, result, is_error, duration_ms) VALUES (?, 1, 'tool', ?, '{}', ?, 0, 1)"
				);
				db.transaction(() => {
					for (let n = 0; n < seeds; n += 1) {
						insert.run(
							Temporal.Now.instant().epochMilliseconds,
							`seed ${n}`,
							megabyte
						);
					}
				})();
				expect(liveBytes(db)).toBeGreaterThan(logCap);
			});
			yield* tool("query", { sql: "SELECT 'capped' AS call" });
			const { live, names } = yield* withDatabase(logFile, (db) => ({
				live: liveBytes(db),
				names: Arr.map(
					db
						.query<{ name: string }, []>(
							"SELECT name FROM entries WHERE kind != 'sync' ORDER BY id"
						)
						.all(),
					(row) => row.name
				),
			}));
			expect(live).toBeLessThanOrEqual(logCap);
			const kept = names.slice(0, -1);
			expect(names.at(-1)).toBe("query");
			expect(kept.length).toBeGreaterThan(0);
			expect(kept.length).toBeLessThan(seeds);
			expect(kept).toEqual(
				Arr.map(Arr.range(seeds - kept.length, seeds - 1), (n) => `seed ${n}`)
			);
		}));

	test(
		"the binary that bun run build cross-compiles for this system starts, answers --version, lists the eleven tools over MCP and answers a query",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				if (!(yield* fs.exists(built.file))) {
					return yield* Effect.die(
						`${built.file} is missing. Build it with bun run build ${built.platform}, as CI does on Linux.`
					);
				}
				// The binary keeps its folders apart from the ones the other tests use.
				const own = join(home, "built");
				const env = {
					APPDATA: join(own, "Roaming"),
					HOME: own,
					LOCALAPPDATA: join(own, "Local"),
					USERPROFILE: own,
					...Rec.getSomes({ SystemRoot: systemRoot }),
				};
				const version = Bun.spawn([built.file, "--version"], {
					env,
					stderr: "inherit",
					stdin: "ignore",
					stdout: "pipe",
				});
				const [code, answer] = yield* Effect.promise(() =>
					Promise.all([version.exited, new Response(version.stdout).text()])
				);
				expect(code).toBe(0);
				expect(answer.trim()).toBe(`mx v${running}`);
				const client = yield* spawnClient([built.file], env);
				const { tools: listed } = (yield* client.request("tools/list")) as {
					tools: { name: string }[];
				};
				expect(Arr.map(listed, ({ name }) => name).sort()).toEqual(tools);
				const counted = yield* client.call("query", {
					sql: "SELECT count(*) AS folders FROM folders",
				});
				expect(counted.isError).toBe(false);
				expect(lines(counted.text).slice(-2)).toEqual(["folders", "0"]);
			}).pipe(Effect.scoped),
		{
			because: "CI builds the binaries of macOS and Windows to run there",
			systems: ["darwin", "win32"],
		}
	);

	test("run from source with no client id saved and no terminal, mx login fails, says how to give the client id, and saves nothing", () =>
		Effect.gen(function* () {
			const login = Bun.spawn(
				[process.execPath, "--no-env-file", "src/main.ts", "login"],
				{
					cwd: `${import.meta.dir}/..`,
					env: {
						...unconfiguredEnvironment,
						// Nothing reaches Microsoft: every request goes to a closed port.
						HTTPS_PROXY: "http://127.0.0.1:9",
						...Rec.getSomes({ SystemRoot: systemRoot }),
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

	test("mx login signs in at the tenant it is given, asks for Mail.Send, and saves the refresh token in the secret store; without a terminal it prints the URL and the code and starts no clipboard or browser program", () =>
		Effect.gen(function* () {
			const before = processes.commands.length;
			const { output } = yield* cli("login");
			expect(new Set(tenantsAsked())).toEqual(new Set([tenant]));
			expect(lines(output)).toContain(
				`Open ${verificationUri} and enter the code ${userCode}.`
			);
			expect(
				Arr.filter(processes.commands.slice(before), ([program = ""]) =>
					desktopPrograms.has(program)
				)
			).toEqual([]);
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

	test("on a terminal, mx login copies the code to the clipboard, says so, opens the sign-in page in the browser on Enter, and signs in, with the programs of Linux, macOS and Windows", () =>
		Effect.forEach(
			[
				{
					browser: ["xdg-open", verificationUri],
					clipboard: ["wl-copy"],
					on: onLinux,
				},
				{
					browser: ["open", verificationUri],
					clipboard: ["pbcopy"],
					on: onMac,
				},
				{
					browser: [
						"rundll32.exe",
						"url.dll,FileProtocolHandler",
						verificationUri,
					],
					clipboard: ["clip.exe"],
					on: onWindows,
				},
			],
			({ browser, clipboard, on }) =>
				Effect.gen(function* () {
					const { system } = fakeTerminal(platform, ["return"]);
					const before = processes.commands.length;
					const { output } = yield* on(
						withStdinTerminal(true)(cliOn(system)("login"))
					);
					expect(lines(output).slice(0, 3)).toEqual([
						`Your sign-in code is ${userCode}. It is on your clipboard.`,
						`Press Enter to open ${verificationUri} in your browser, then paste the code there.`,
						"Signed in. The refresh token is saved.",
					]);
					expect(processes.commands.slice(before, before + 2)).toEqual([
						clipboard,
						browser,
					]);
					expect(processes.inputs.get(before)).toBe(userCode);
					expect(yield* savedRefreshToken).toBe(issued(1));
				}),
			{ discard: true }
		));

	test("on a terminal, mx login signs in when the code is entered with no key pressed, and opens no browser", () =>
		Effect.gen(function* () {
			const { system } = fakeTerminal(platform, []);
			const before = processes.commands.length;
			const { output } = yield* withStdinTerminal(true)(cliOn(system)("login"));
			expect(lines(output)).toContain("Signed in. The refresh token is saved.");
			expect(
				Arr.filter(processes.commands.slice(before), ([program = ""]) =>
					browsers.has(program)
				)
			).toEqual([]);
			expect(yield* savedRefreshToken).toBe(issued(1));
		}));

	test("on a terminal on Linux where no clipboard program works, mx login tries wl-copy, xclip and xsel, asks to enter the code, and Enter still opens the browser", () =>
		onLinux(
			Effect.gen(function* () {
				processes.missing.add("wl-copy").add("xsel");
				processes.failing.add("xclip");
				const { system } = fakeTerminal(platform, ["return"]);
				const before = processes.commands.length;
				const { output } = yield* withStdinTerminal(true)(
					cliOn(system)("login")
				);
				expect(lines(output).slice(0, 2)).toEqual([
					`Your sign-in code is ${userCode}.`,
					`Press Enter to open ${verificationUri} in your browser, then enter the code there.`,
				]);
				expect(processes.commands.slice(before, before + 4)).toEqual([
					["wl-copy"],
					["xclip", "-selection", "clipboard"],
					["xsel", "--clipboard", "--input"],
					["xdg-open", verificationUri],
				]);
			})
		).pipe(Effect.ensuring(restorePrograms)));

	test("on a terminal on Linux where wl-copy never exits, mx login kills it, copies the code with xclip, says so, and signs in", () =>
		onLinux(
			Effect.gen(function* () {
				processes.hanging.add("wl-copy");
				const { system } = fakeTerminal(platform, ["return"]);
				const before = processes.commands.length;
				const { output } = yield* withStdinTerminal(true)(
					cliOn(system)("login")
				).pipe(onTestClock);
				expect(processes.commands.slice(before, before + 2)).toEqual([
					["wl-copy"],
					["xclip", "-selection", "clipboard"],
				]);
				expect(processes.killed.has(before)).toBe(true);
				expect(processes.inputs.get(before + 1)).toBe(userCode);
				expect(lines(output).slice(0, 3)).toEqual([
					`Your sign-in code is ${userCode}. It is on your clipboard.`,
					`Press Enter to open ${verificationUri} in your browser, then paste the code there.`,
					"Signed in. The refresh token is saved.",
				]);
				expect(yield* savedRefreshToken).toBe(issued(1));
			})
		).pipe(Effect.ensuring(restorePrograms)));

	test("on a terminal where no browser opens, Enter makes mx login say to open the sign-in page, and it still signs in", () =>
		onLinux(
			Effect.gen(function* () {
				processes.failing.add("xdg-open");
				const { system } = fakeTerminal(platform, ["return"]);
				const { output } = yield* withStdinTerminal(true)(
					cliOn(system)("login")
				);
				expect(lines(output).slice(2, 4)).toEqual([
					`Could not open a browser. Open ${verificationUri} yourself.`,
					"Signed in. The refresh token is saved.",
				]);
			})
		).pipe(Effect.ensuring(restorePrograms)));

	test("on a terminal, input that ends before Enter, as Ctrl+C ends it, stops mx login without signing in and without an error", () =>
		Effect.gen(function* () {
			const { close, reading, system } = fakeTerminal(platform, []);
			const tokens = microsoft.refreshTokens.length;
			const login = yield* Effect.forkChild(
				withStdinTerminal(true)(runOn(system)("login"))
			);
			yield* eventually("mx to wait for Enter", reading);
			yield* close;
			const { errors, exit, output } = yield* Fiber.join(login);
			expect(Exit.hasInterrupts(exit)).toBe(true);
			expect(errors).toBe("");
			expect(output).not.toContain("Signed in.");
			expect(microsoft.refreshTokens).toHaveLength(tokens);
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

	test(
		"without a secret store, mx login saves the refresh token in a file only the user can read",
		() =>
			Effect.gen(function* () {
				secrets.machine = "none";
				yield* cli("login");
				const fs = yield* FileSystem.FileSystem;
				expect((yield* fs.stat(tokenFile)).mode % 0o1000).toBe(0o600);
				expect(yield* refreshTokenIn(yield* fs.readFileString(tokenFile))).toBe(
					issued(1)
				);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						secrets.machine = "store";
					})
				)
			),
		{
			because:
				"only a Linux machine can lack a secret store, and Windows has no file modes",
			systems: ["linux"],
		}
	);

	test("a secret store that fails for any other reason fails loudly and writes no file", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const before = yield* Effect.option(fs.readFileString(tokenFile));
			secrets.machine = "broken";
			const failure = yield* Effect.flip(cli("login"));
			secrets.machine = "store";
			expect(failure.message).toContain(
				"The secret store failed: Could not connect"
			);
			expect(yield* Effect.option(fs.readFileString(tokenFile))).toEqual(
				before
			);
		}));

	test(
		"mx login saves the refresh token in the system's secret store, Credential Manager on Windows and the Keychain on macOS, where mx status finds it",
		() =>
			Effect.acquireUseRelease(
				// A developer's own mx sign-in on this machine goes back in place after the test.
				Effect.promise(() => systemSecrets.get(credential)).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							Reflect.set(Bun, "secrets", systemSecrets);
						})
					)
				),
				() =>
					Effect.gen(function* () {
						yield* cli("login");
						expect(
							yield* refreshTokenIn(
								yield* Effect.promise(() => systemSecrets.get(credential))
							)
						).toBe(issued(1));
						expect(lines((yield* status).output)).toContain("Sign-in: saved");
					}),
				(saved) =>
					Effect.promise(() => {
						secrets.install();
						return saved === null
							? systemSecrets.delete(credential).then(() => undefined)
							: systemSecrets.set({ ...credential, value: saved });
					})
			),
		{
			because: "the Linux runners have no Secret Service",
			systems: ["darwin", "win32"],
		}
	);

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
			if (mac) {
				// On macOS, what mx install registers is the LaunchAgent's plist; launchd has not loaded it yet.
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(dirname(agentFile), { recursive: true });
				yield* fs.writeFileString(agentFile, "");
			}
			const before = processes.commands.length;
			const { output } = yield* cliOn(unconfigured)("login");
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual([...syncCommands.registered, ...syncCommands.start]);
			expect(lines(output).at(-1)).toBe("Restarted mx sync.");
		}));

	test("mx sync records a heartbeat after its first pass, and mx status reports it running with its mode, both versions, a saved sign-in, the client id and the tenant, and no error", () =>
		Effect.gen(function* () {
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"a heartbeat after the first pass",
				Effect.map(
					status,
					({ output: report }) =>
						report.includes("Mode: poll") &&
						!report.includes("Last sync: never")
				)
			);
			yield* Fiber.interrupt(service);
			const { exit, output } = yield* status;
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(lines(output)).toEqual([
				expect.stringMatching(runningLine),
				expect.stringMatching(lastSyncLine),
				"Mode: poll",
				`Version: mx sync ${running}, this binary ${running}`,
				"Sign-in: saved",
				"Client id: set",
				`Tenant: ${tenant}`,
				"Last error: none",
			]);
		}));

	test("mx sync writes each line it logs to the log as it logs it, where mx log --sync shows it, and on Windows it writes no sync.log", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const syncRows = Effect.map(
					loggedRows("--sync", "--limit", "100"),
					(rows) =>
						Arr.filter(rows, (row) => (row as { kind: string }).kind === "sync")
				);
				// The clock stands still at the present, so a line mx sync held back for a while would stay out of the log,
				// and the heartbeat it records is current for the tests after it.
				const service = yield* Effect.forkChild(
					TestClock.setTime(Temporal.Now.instant().epochMilliseconds).pipe(
						Effect.andThen(cli("sync")),
						// @effect-diagnostics-next-line strictEffectProvide:off - the clock that stands still, above.
						Effect.provide(TestClock.layer())
					)
				);
				yield* eventually(
					"the push line in the log while mx sync runs",
					Effect.map(
						syncRows,
						Arr.some((row) =>
							pushModeLine.test((row as { message: string }).message)
						)
					)
				);
				expect(yield* syncRows).toContainEqual({
					at: expect.stringMatching(instantText),
					id: expect.any(Number),
					kind: "sync",
					level: "Info",
					message: expect.stringMatching(pushModeLine),
					pid: process.pid,
				});
				yield* Fiber.interrupt(service);
				expect(
					Arr.filter(
						yield* loggedRows("--limit", "100"),
						(row) => (row as { kind: string }).kind === "sync"
					)
				).toEqual([]);
				expect(yield* fs.exists(join(local, "state", "sync.log"))).toBe(false);
			})
		));

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
				expect(request.prefer).toContain("odata.maxpagesize=100");
			}
			const answer = yield* call("search", { limit: 50 });
			expect(answer.structured).toBeUndefined();
			expect(lines(answer.text)).toHaveLength(4);
			expect(answer.text).toContain("(+2 in thread)");
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
			expect(yield* savedRefreshToken).toBe(issued(1));
		}));

	test("a pass syncs up to 3 folders at once and no more", () =>
		Effect.gen(function* () {
			microsoft.deltaDelay = Duration.millis(100);
			microsoft.mostDeltasAtOnce = 0;
			yield* cli("sync", "--once");
			expect(microsoft.mostDeltasAtOnce).toBe(3);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.deltaDelay = Duration.zero;
				})
			)
		));

	test("search finds by words in the subject, the sender and the new text, with folder, from and since filters", () =>
		Effect.gen(function* () {
			expect(lines(yield* tool("search", { query: "travel" }))).toHaveLength(1);
			const lunch = yield* tool("search", { query: "carol" });
			expect(lunch).toContain("Lunch plans");
			expect(lunch).not.toContain("https://");
			const inbox = yield* tool("search", { folder: "Inbox", query: "budget" });
			expect(lines(inbox)).toHaveLength(1);
			expect(inbox).not.toContain("Sent Items");
			expect(yield* tool("search", { from: "alice@example.test" })).toMatch(
				aliceLatestLine
			);
			const since = yield* tool("search", { since: "2026-10-03" });
			expect(since).toContain("Lunch plans");
			expect(since).not.toContain("Kickoff notes");
			expect(yield* tool("search", { query: "nothing-matches-this" })).toBe(
				"No messages."
			);
		}));

	test("search ranks a thread whose subject matches above newer automated messages that only mention the word in their body, and limit counts conversations", () =>
		Effect.gen(function* () {
			microsoft.deliver({
				body: "Let us pick the next novel by Friday.",
				conversationId: "conversation-book-club",
				from: priya,
				parentFolderId: "folder-inbox",
				received: "2026-10-07T10:00:00Z",
				subject: "Book club: the next novel",
			});
			microsoft.deliver({
				body: "I vote for the mystery.",
				conversationId: "conversation-book-club",
				from: jonas,
				parentFolderId: "folder-inbox",
				received: "2026-10-07T12:00:00Z",
				subject: "RE: Book club: the next novel",
			});
			for (const [day, share] of nightlyBackups) {
				microsoft.deliver({
					body: `The nightly backup of ${share} failed. Skipped: novel-draft.txt.`,
					conversationId: `conversation-backup-${day}`,
					from: alerts,
					parentFolderId: "folder-inbox",
					received: `2026-10-${day}T01:00:00Z`,
					subject: `Nightly backup failed: ${share}`,
				});
			}
			yield* cli("sync", "--once");
			const found = lines(yield* tool("search", { query: "novel" }));
			expect(found).toEqual([
				expect.stringMatching(bookClubLine),
				expect.stringContaining("| Nightly backup failed: music |"),
				expect.stringContaining("| Nightly backup failed: documents |"),
				expect.stringContaining("| Nightly backup failed: photos |"),
			]);
			expect(
				lines(yield* tool("search", { limit: 2, query: "novel" }))
			).toEqual(found.slice(0, 2));
		}));

	test("search matches other forms of a word: approve finds approved and approval", () =>
		Effect.gen(function* () {
			microsoft.deliver({
				body: "The seed order was approved this morning.",
				conversationId: "conversation-garden",
				from: marta,
				parentFolderId: "folder-inbox",
				received: "2026-10-03T09:30:00Z",
				subject: "Garden supplies order",
			});
			microsoft.deliver({
				body: "The itinerary waits for your approval.",
				conversationId: "conversation-trip",
				from: jonas,
				parentFolderId: "folder-inbox",
				received: "2026-10-03T10:30:00Z",
				subject: "Trip itinerary",
			});
			yield* cli("sync", "--once");
			const found = lines(yield* tool("search", { query: "approve" }));
			expect(found).toHaveLength(2);
			expect(Arr.join(found, "\n")).toContain("| Garden supplies order |");
			expect(Arr.join(found, "\n")).toContain("| Trip itinerary |");
		}));

	test("search lists a conversation with several matching messages once, with how many more messages its thread holds", () =>
		Effect.gen(function* () {
			for (const [hour, from, body] of [
				["08", jonas, "Bring your best lasagna recipe."],
				["09", priya, "My lasagna uses spinach."],
				["10", marta, "Lasagna with mushrooms here."],
				["11", jonas, "See you on Saturday."],
			] as const) {
				microsoft.deliver({
					body,
					conversationId: "conversation-recipes",
					from,
					parentFolderId: "folder-inbox",
					received: `2026-10-02T${hour}:00:00Z`,
					subject: hour === "08" ? "Recipe swap" : "RE: Recipe swap",
				});
			}
			yield* cli("sync", "--once");
			const found = lines(yield* tool("search", { query: "lasagna" }));
			expect(found).toEqual([expect.stringMatching(recipeSwapLine)]);
		}));

	test("search without a query lists conversations newest first, each by its newest message", () =>
		Effect.gen(function* () {
			expect(lines(yield* tool("search", { limit: 4 }))).toEqual([
				expect.stringContaining("| Nightly backup failed: music |"),
				expect.stringContaining("| Nightly backup failed: documents |"),
				expect.stringContaining("| Nightly backup failed: photos |"),
				expect.stringMatching(bookClubReplyLine),
			]);
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
			expect(thread).not.toContain("From: Sam Example");
			expect(thread).toContain("[img 1]");
		}));

	test("thread and message show, below each message's headers, the link that opens it in Outlook on the web", () =>
		Effect.gen(function* () {
			const id = idOf(yield* tool("search", { query: "lunch" }), "Lunch plans");
			expect(yield* tool("message", { id })).toContain(
				`Subject:Lunch plans\nOpen in Outlook: ${lunchLink}\n\nLunch on Friday?`
			);
			expect(yield* tool("thread", { id })).toContain(
				`To: Sam Example <sam@example.test>\nOpen in Outlook: ${lunchLink}\nLunch on Friday?`
			);
			const budget = yield* tool("thread", {
				id: idOf(yield* tool("search", { query: "travel cap" }), "RE:"),
			});
			expect(budget.match(outlookLine)).toHaveLength(3);
		}));

	test("query answers a GROUP BY over mail as a tab-separated table with a header: messages per sender", () =>
		Effect.gen(function* () {
			microsoft.addFolder("folder-clubs", "Clubs", "folder-root");
			for (const [day, from, conversationId, subject] of [
				["20", priya, "conversation-chess", "Chess club: spring fixtures"],
				["21", jonas, "conversation-chess", "RE: Chess club: spring fixtures"],
				["22", priya, "conversation-boards", "Chess club: the new boards"],
			] as const) {
				microsoft.deliver({
					body: `${subject}.`,
					conversationId,
					from,
					parentFolderId: "folder-clubs",
					received: `2026-09-${day}T18:00:00Z`,
					subject,
				});
			}
			yield* cli("sync", "--once");
			expect(
				yield* tool("query", {
					sql: "SELECT from_address, count(*) AS messages FROM mail WHERE folder = 'Clubs' GROUP BY from_address ORDER BY messages DESC",
				})
			).toBe(
				"from_address\tmessages\npriya@example.com\t2\njonas@example.com\t1"
			);
		}));

	test("query joins mail and folders, where each folder counts its stored and unread messages", () =>
		Effect.gen(function* () {
			yield* tool("update", {
				ids: [
					idOf(
						yield* tool("search", { folder: "Clubs", query: "boards" }),
						"boards"
					),
				],
				read: true,
			});
			expect(
				yield* tool("query", {
					sql: "SELECT f.path, f.total, f.unread, count(*) AS from_priya FROM folders f JOIN mail m ON m.folder = f.path WHERE f.path = 'Clubs' AND m.from_address = 'priya@example.com' GROUP BY f.path",
				})
			).toBe("path\ttotal\tunread\tfrom_priya\nClubs\t3\t2\t2");
		}));

	test("query runs a CTE with a window function, with times in UTC ISO 8601", () =>
		Effect.gen(function* () {
			expect(
				yield* tool("query", {
					sql: "WITH ranked AS (SELECT subject, received_at, row_number() OVER (PARTITION BY conversation_id ORDER BY received_at DESC) AS place FROM mail WHERE folder = 'Clubs') SELECT subject, received_at FROM ranked WHERE place = 1 ORDER BY received_at DESC",
				})
			).toBe(
				"subject\treceived_at\nChess club: the new boards\t2026-09-22T18:00:00Z\nRE: Chess club: spring fixtures\t2026-09-21T18:00:00Z"
			);
		}).pipe(
			// The folder the query tests read leaves the mailbox and the store with this last of them.
			Effect.ensuring(
				Effect.suspend(() => {
					microsoft.removeFolder("folder-clubs");
					return Effect.orDie(cli("sync", "--once"));
				})
			)
		));

	test("query marks the user's own messages from_me as thread marks them (me), and conversations names each conversation's newest message", () =>
		Effect.gen(function* () {
			expect(
				yield* tool("query", {
					sql: "SELECT folder, from_address, to_addresses, from_me FROM mail WHERE conversation_id = 'conversation-budget' ORDER BY sent_at",
				})
			).toBe(
				'folder\tfrom_address\tto_addresses\tfrom_me\nInbox\talice@example.test\t["sam@example.test"]\t0\nSent Items\tsam@example.test\t["alice@example.test"]\t1\nInbox\talice@example.test\t["sam@example.test"]\t0'
			);
			expect(
				yield* tool("query", {
					sql: "SELECT c.messages, c.unread, c.mine, m.subject, m.from_me FROM conversations c JOIN mail m ON m.id = c.last_id WHERE c.conversation_id = 'conversation-budget'",
				})
			).toBe(
				"messages\tunread\tmine\tsubject\tfrom_me\n3\t2\t1\tRE: Quarterly budget\t0"
			);
		}));

	test("query gives each message's Outlook link in mail and each conversation's newest in conversations, and never cuts a link", () =>
		Effect.gen(function* () {
			expect(
				yield* tool("query", {
					sql: "SELECT m.link, c.last_link FROM mail m JOIN conversations c USING (conversation_id) WHERE m.subject = 'Lunch plans'",
				})
			).toBe(`link\tlast_link\n${lunchLink}\t${lunchLink}`);
			expect(
				yield* tool("query", {
					sql: "SELECT last_link FROM conversations WHERE conversation_id = 'conversation-budget'",
				})
			).toBe(
				"last_link\nhttps://outlook.cloud.microsoft/mail/deeplink?ItemID=message%2Fanswer&exvsurl=1&viewmodel=ReadMessageItem"
			);
			const longer = lunchLink.replace("ItemID=", `ItemID=${"A".repeat(100)}`);
			expect(yield* tool("query", { sql: `SELECT '${longer}' AS link` })).toBe(
				`link\n${longer}`
			);
		}));

	test("query refuses anything but one SELECT with SQLite's own error, and changes nothing", () =>
		Effect.gen(function* () {
			const copy = join(home, "query-copy.sqlite");
			const counts =
				"SELECT (SELECT count(*) FROM mail) AS messages, (SELECT count(*) FROM folders) AS folders";
			const before = yield* tool("query", { sql: counts });
			expect(
				yield* Effect.forEach(
					[
						"INSERT INTO folders (id, parent_id, name, path, sent) VALUES ('invented', 'folder-root', 'Invented', 'Invented', 0)",
						"ATTACH 'other.sqlite' AS other",
						"PRAGMA journal_mode = DELETE",
						"SELECT 1; DELETE FROM messages",
						`VACUUM INTO '${copy}'`,
						"SELECT load_extension('extension')",
						"SELECT 1) ; DELETE FROM messages; SELECT * FROM (SELECT 1",
						"SELECT * FROM mail WHERE id = ?",
					],
					(sql) => refusal("query", { sql })
				)
			).toEqual([
				'near "INSERT": syntax error',
				'near "AS": syntax error',
				'near "=": syntax error',
				'near ";": syntax error',
				'near "INTO": syntax error',
				// Apple's system SQLite is built without load_extension at all.
				process.platform === "darwin"
					? "no such function: load_extension"
					: "not authorized",
				"SQLite ended the statement before the end of the SQL; query runs one SELECT with nothing after it.",
				"query binds no parameters; write each value into the SQL.",
			]);
			expect(yield* tool("query", { sql: counts })).toBe(before);
			expect(yield* (yield* FileSystem.FileSystem).exists(copy)).toBe(false);
		}));

	test("query answers at most 200 rows and 20000 characters, cuts each value at 200 characters, and says when it stopped", () =>
		Effect.gen(function* () {
			const counting =
				"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 300) SELECT i FROM n";
			const firstRows = [
				"i",
				...Arr.makeBy(200, (i) => String(i + 1)),
				"(first 200 rows; refine the query)",
			];
			expect(lines(yield* tool("query", { sql: counting }))).toEqual(firstRows);
			// A comment left open after a closing parenthesis hides mx's own LIMIT; the cap still holds.
			expect(
				lines(yield* tool("query", { sql: `${counting}) LIMIT 1000 /*` }))
			).toEqual(firstRows);
			const wide = lines(
				yield* tool("query", {
					sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 150) SELECT i, printf('%.*c', 1000, 'x') AS filler FROM n",
				})
			);
			expect(wide[1]).toBe(`1\t${"x".repeat(199)}…`);
			expect(wide.at(-1)).toMatch(cutAtCharacters);
			expect(Arr.join(wide.slice(0, -1), "\n").length).toBeLessThanOrEqual(
				20_000
			);
		}));

	test("query stops a query that runs past 10 seconds and says so, while mx mcp answers other calls", () =>
		Effect.gen(function* () {
			const { client, stdio } = yield* connect();
			yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
				Effect.provide(stdio),
				// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
				Effect.provide(platform, { local: true }),
				Effect.forkScoped
			);
			const runaway = yield* Effect.forkChild(
				client.call("query", {
					sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) AS forever FROM n",
				})
			);
			const listed = yield* client.call("search", { query: "lunch" });
			expect(listed.text).toContain("Lunch plans");
			expect(runaway.pollUnsafe()).toBeUndefined();
			const stopped = yield* Effect.raceFirst(
				Fiber.join(runaway),
				Effect.forever(
					Effect.andThen(settleBriefly, TestClock.adjust("1 second"))
				)
			);
			expect(stopped.isError).toBe(true);
			expect(lines(stopped.text).at(-1)).toBe(
				"The query ran past 10 seconds, so mx stopped it. Narrow it down and run it again."
			);
		}).pipe(
			Effect.scoped,
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one mx mcp process runs on.
			Effect.provide(TestClock.layer())
		));

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
			expect(saved.startsWith(cacheFolder)).toBe(true);
			expect(yield* fileSha256(saved)).toBe(sha256(inlineImage));
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
				yield* tool("search", { folder: "Inbox/Projects", query: "kickoff" }),
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
				yield* tool("search", { folder: "Inbox/Projects", query: "kickoff" }),
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
			const lunch = idOf(
				yield* tool("search", { folder: "Inbox", query: "lunch" }),
				"Inbox"
			);
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
			const lunch = idOf(
				yield* tool("search", { folder: "Inbox", query: "lunch" }),
				"Inbox"
			);
			const kickoff = idOf(
				yield* tool("search", { folder: "Archive", query: "kickoff" }),
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

	test("folder creates each missing folder of a path, and search and query see the new folders at once", () =>
		Effect.gen(function* () {
			const asked = microsoft.graphRequests().length;
			expect(yield* tool("folder", { create: "Clients/Acme/Contracts" })).toBe(
				"Created Clients, Clients/Acme, Clients/Acme/Contracts."
			);
			expect(yield* tool("folder", { create: "Clients/Globex" })).toBe(
				"Created Clients/Globex."
			);
			expect(
				Arr.map(
					Arr.filter(
						microsoft.graphRequests().slice(asked),
						(request) => request.method === "POST"
					),
					({ body, url }) => `${url.pathname} ${body}`
				)
			).toEqual([
				'/v1.0/me/mailFolders {"displayName":"Clients"}',
				`/v1.0/me/mailFolders/${microsoft.folderId("Clients")}/childFolders {"displayName":"Acme"}`,
				`/v1.0/me/mailFolders/${microsoft.folderId("Acme")}/childFolders {"displayName":"Contracts"}`,
				`/v1.0/me/mailFolders/${microsoft.folderId("Clients")}/childFolders {"displayName":"Globex"}`,
			]);
			expect(yield* tool("search", { folder: "Clients/Acme/Contracts" })).toBe(
				"No messages."
			);
			expect(
				yield* tool("query", {
					sql: "SELECT path, total FROM folders WHERE path LIKE 'Clients%' ORDER BY path",
				})
			).toBe(
				"path\ttotal\nClients\t0\nClients/Acme\t0\nClients/Acme/Contracts\t0\nClients/Globex\t0"
			);
		}));

	test("folder renames and moves a folder, and the local copy shows the new paths at once, for the folders and mail inside it too, as the next sync does", () =>
		Effect.gen(function* () {
			microsoft.deliver({
				body: "The signed contract is attached.",
				conversationId: "conversation-contract",
				from: priya,
				parentFolderId: microsoft.folderId("Contracts"),
				received: "2026-10-09T09:00:00Z",
				subject: "Acme contract",
			});
			yield* cli("sync", "--once");
			const contract = idOf(
				yield* tool("search", { query: "contract" }),
				"Acme contract"
			);
			expect(
				yield* tool("folder", { name: "Acme Corp", rename: "Clients/Acme" })
			).toBe("Renamed Clients/Acme to Clients/Acme Corp.");
			expect(yield* tool("message", { id: contract })).toMatch(
				lineIn(contract, "Clients/Acme Corp/Contracts")
			);
			expect(yield* tool("folder", { move: "Acme Corp", to: "Inbox" })).toBe(
				"Moved Clients/Acme Corp to Inbox/Acme Corp."
			);
			expect(yield* tool("folder", { move: "Globex", to: "/" })).toBe(
				"Moved Clients/Globex to Globex."
			);
			expect(
				yield* tool("search", { folder: "Inbox/Acme Corp/Contracts" })
			).toMatch(lineIn(contract, "Inbox/Acme Corp/Contracts"));
			expect(
				yield* refusal("search", { folder: "Clients/Acme Corp" })
			).toContain("No folder named Clients/Acme Corp.");
			const paths = {
				sql: "SELECT path FROM folders WHERE path LIKE '%Acme%' OR path LIKE '%Globex%' OR path LIKE 'Clients%' ORDER BY path",
			};
			const moved =
				"path\nClients\nGlobex\nInbox/Acme Corp\nInbox/Acme Corp/Contracts";
			expect(yield* tool("query", paths)).toBe(moved);
			yield* cli("sync", "--once");
			expect(yield* tool("query", paths)).toBe(moved);
		}));

	test("delete_folder moves a folder with everything in it to Deleted Items through move, never DELETE, and its mail leaves the folders it was in at once", () =>
		Effect.gen(function* () {
			const contract = idOf(
				yield* tool("search", { query: "contract" }),
				"Acme contract"
			);
			expect(yield* tool("delete_folder", { folder: "Inbox/Acme Corp" })).toBe(
				"Moved Inbox/Acme Corp to Deleted Items/Acme Corp, where Outlook can restore it."
			);
			expect(
				graphRequests(
					`/mailFolders/${microsoft.folderId("Acme Corp")}/move`
				).at(-1)?.body
			).toBe('{"destinationId":"deleteditems"}');
			expect(
				Arr.filter(
					microsoft.received,
					(request) =>
						request.method === "DELETE" || permanent.test(request.url.pathname)
				)
			).toEqual([]);
			expect(yield* tool("message", { id: contract })).toMatch(
				lineIn(contract, "Deleted Items/Acme Corp/Contracts")
			);
			expect(
				yield* refusal("search", { folder: "Inbox/Acme Corp/Contracts" })
			).toContain("No folder named Inbox/Acme Corp/Contracts.");
			expect(
				yield* tool("query", {
					sql: "SELECT folder FROM mail WHERE conversation_id = 'conversation-contract'",
				})
			).toBe("folder\nDeleted Items/Acme Corp/Contracts");
		}));

	test("folder and delete_folder refuse Outlook's own folders, Deleted Items and the folders in it, and send Graph no change", () =>
		Effect.gen(function* () {
			const changes = () =>
				Arr.filter(
					microsoft.graphRequests(),
					(request) => request.method !== "GET"
				).length;
			const before = changes();
			for (const [name, args] of [
				["folder", { name: "Incoming", rename: "Inbox" }],
				["folder", { move: "Sent Items", to: "Archive" }],
				["delete_folder", { folder: "Drafts" }],
				["delete_folder", { folder: "Deleted Items" }],
			] as const) {
				expect(yield* refusal(name, args)).toContain(
					"is one of Outlook's own folders"
				);
			}
			for (const [name, args] of [
				["delete_folder", { folder: "Deleted Items/Acme Corp" }],
				["folder", { name: "Acme", rename: "Deleted Items/Acme Corp" }],
				["folder", { move: "Contracts", to: "Inbox" }],
				["folder", { create: "Deleted Items/Acme Corp/Drafts" }],
			] as const) {
				expect(yield* refusal(name, args)).toContain("in Deleted Items");
			}
			expect(
				yield* refusal("folder", { move: "Clients", to: "Deleted Items" })
			).toContain("use delete_folder");
			expect(changes()).toBe(before);
		}));

	test("folder says when the folder that would hold the folder already holds one of that name", () =>
		Effect.gen(function* () {
			microsoft.addFolder("folder-receipts", "Receipts", "folder-inbox");
			expect(yield* refusal("folder", { create: "Inbox/Receipts" })).toBe(
				"Inbox already has a folder named Receipts."
			);
			expect(
				yield* refusal("folder", { name: "Globex", rename: "Clients" })
			).toBe("The top of the mailbox already has a folder named Globex.");
		}).pipe(
			// The folders the folder tests made leave the mailbox and the store with this last of them.
			Effect.ensuring(
				Effect.suspend(() => {
					for (const name of ["Clients", "Globex", "Acme Corp", "Receipts"]) {
						microsoft.removeFolder(microsoft.folderId(name));
					}
					return Effect.orDie(cli("sync", "--once"));
				})
			)
		));

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

	test("a delta entry with only the properties that changed, as Graph sends for a message read in Deleted Items, stores the message as Graph holds it, and the rest of its page too", () =>
		Effect.gen(function* () {
			const deleted = (subject: string) =>
				microsoft.deliver({
					body: `${subject}.`,
					conversationId: "conversation-shed",
					from: rosa,
					parentFolderId: "folder-deleted",
					received: "2026-10-10T09:00:00Z",
					subject,
				});
			const hose = deleted("Hose repair");
			const ladder = deleted("Ladder loan");
			yield* cli("sync", "--once");
			microsoft.readInOutlook(hose.id);
			deleted("Rain barrel");
			microsoft.purge(ladder.id);
			yield* cli("sync", "--once");
			expect(
				yield* tool("query", {
					sql: "SELECT folder, subject, is_read FROM mail WHERE conversation_id = 'conversation-shed' ORDER BY subject",
				})
			).toBe(
				"folder\tsubject\tis_read\nDeleted Items\tHose repair\t1\nDeleted Items\tRain barrel\t0"
			);
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

	test("a message that moves while its old folder's delta page is on the way stays in the folder it moved to", () =>
		Effect.gen(function* () {
			const rota = microsoft.deliver({
				body: "Who waters the tomatoes this week?",
				conversationId: "conversation-garden",
				from: rosa,
				parentFolderId: "folder-inbox",
				received: "2026-10-07T07:00:00Z",
				subject: "Garden plot rota",
			});
			const asked = deltaRequests("folder-inbox");
			const ended = microsoft.roundsEnded.length;
			microsoft.hold("folder-inbox", { answered: true });
			microsoft.hold("folder-archive");
			const pass = yield* Effect.forkChild(cli("sync", "--once"));
			yield* eventually(
				"the Inbox page that still holds the message",
				() => deltaRequests("folder-inbox") > asked
			);
			microsoft.move(rota.id, "folder-archive");
			microsoft.release("folder-archive");
			yield* eventually("the Archive round", () =>
				microsoft.roundsEnded.slice(ended).includes("folder-archive")
			);
			microsoft.release("folder-inbox");
			yield* Fiber.join(pass);
			yield* cli("sync", "--once");
			expect(yield* tool("search", { query: "tomatoes" })).toMatch(
				rotaInArchiveLine
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release("folder-inbox");
					microsoft.release("folder-archive");
				})
			)
		));

	test("a message mx mcp moves while mx sync looks it up stays where mx mcp moved it", () =>
		Effect.gen(function* () {
			const ledger = microsoft.deliver({
				body: "The water fund stands at forty pounds.",
				conversationId: "conversation-ledger",
				from: rosa,
				parentFolderId: "folder-inbox",
				received: "2026-10-07T08:00:00Z",
				subject: "Water fund ledger",
			});
			yield* cli("sync", "--once");
			const id = idOf(yield* tool("search", { query: "ledger" }), "ledger");
			const reads = () =>
				Arr.filter(
					graphRequests(`/me/messages/${ledger.id}`),
					(request) => request.method === "GET"
				).length;
			const before = reads();
			// The Archive page brings the move while the store still files the message in Inbox, so mx sync looks it up.
			microsoft.move(ledger.id, "folder-archive");
			microsoft.hold("folder-inbox");
			microsoft.holdRead(ledger.id);
			const pass = yield* Effect.forkChild(cli("sync", "--once"));
			yield* eventually(
				"mx sync looking the message up",
				() => reads() > before
			);
			expect(yield* tool("update", { ids: [id], move_to: "Projects" })).toMatch(
				lineIn(id, "Inbox/Projects")
			);
			microsoft.releaseReads();
			microsoft.release("folder-inbox");
			yield* Fiber.join(pass);
			expect(yield* tool("message", { id })).toMatch(
				lineIn(id, "Inbox/Projects")
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.releaseReads();
					microsoft.release("folder-inbox");
				})
			)
		));

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

	test("while push is up, mx status reports sync running in push mode", () =>
		Effect.gen(function* () {
			yield* eventually(
				"push mode in mx status",
				Effect.map(status, ({ output: report }) =>
					report.includes("Mode: push")
				)
			);
			const { exit, output } = yield* status;
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(lines(output)[0]).toMatch(runningLine);
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

	test("after its first pass, mx sync checks the store against Graph: it adds a message the delta never delivered, refiles one stored in the wrong folder, removes one Graph no longer has, and drops a deleted folder with its messages", () =>
		Effect.gen(function* () {
			const seeds = microsoft.deliver({
				body: "Bring spare bean seeds on Saturday.",
				conversationId: "conversation-seeds",
				from: rosa,
				parentFolderId: "folder-inbox",
				received: "2026-10-08T08:00:00Z",
				subject: "Seed swap",
			});
			const compost = microsoft.deliver({
				body: "The compost bins are full again.",
				conversationId: "conversation-compost",
				from: rosa,
				parentFolderId: "folder-inbox",
				received: "2026-10-08T09:00:00Z",
				subject: "Compost bins",
			});
			microsoft.addFolder("folder-allotment", "Allotment", "folder-inbox");
			microsoft.deliver({
				body: "Plot seven is free from November.",
				conversationId: "conversation-plot",
				from: rosa,
				parentFolderId: "folder-allotment",
				received: "2026-10-08T10:00:00Z",
				subject: "Plot seven",
			});
			yield* cli("sync", "--once");
			const seedsId = idOf(yield* tool("search", { query: "seeds" }), "Seed");
			const compostId = idOf(
				yield* tool("search", { query: "compost" }),
				"Compost"
			);
			expect(yield* tool("search", { folder: "Allotment" })).toContain(
				"Plot seven"
			);
			microsoft.missedByDelta(() => {
				microsoft.deliver({
					body: "Rain is due on Sunday, so the hedge trimming moves to Monday.",
					conversationId: "conversation-hedge",
					from: rosa,
					parentFolderId: "folder-inbox",
					received: "2026-10-08T11:00:00Z",
					subject: "Hedge trimming moved",
				});
				microsoft.move(compost.id, "folder-archive");
				microsoft.purge(seeds.id);
			});
			microsoft.removeFolder("folder-allotment");
			const listed = idListings().length;
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"the store in step with Graph",
				Effect.gen(function* () {
					const hedge = yield* call("search", { query: "hedge" });
					const moved = yield* call("message", { id: compostId });
					const purged = yield* call("message", { id: seedsId });
					return (
						hedge.text.includes("Hedge trimming moved") &&
						lineIn(compostId, "Archive").test(moved.text) &&
						purged.isError
					);
				})
			);
			yield* Fiber.interrupt(service);
			expect(yield* refusal("search", { folder: "Allotment" })).toContain(
				"No folder named Allotment."
			);
			const listings = idListings().slice(listed);
			expect(listings.length).toBeGreaterThan(allFolders.length);
			for (const { prefer, url } of listings) {
				expect(url.searchParams.get("$select")).toBe("id");
				expect(url.searchParams.get("$top")).toBe("1000");
				expect(prefer).toContain('IdType="ImmutableId"');
				expect(prefer).not.toContain("maxpagesize");
			}
		}));

	test("a delta pass waits while the check against Graph lists the ids of the same folder", () =>
		Effect.gen(function* () {
			microsoft.hold("folder-inbox", { answered: true, ids: true });
			const asked = inboxIdListings();
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"the check listing Inbox",
				() => inboxIdListings() > asked
			);
			const before = deltaRequests("folder-inbox");
			yield* TestClock.adjust("60 seconds");
			yield* settle;
			expect(deltaRequests("folder-inbox")).toBe(before);
			microsoft.release("folder-inbox", { ids: true });
			yield* eventually(
				"the delta pass of Inbox after the check",
				TestClock.adjust("5 seconds").pipe(
					Effect.andThen(settleBriefly),
					Effect.map(() => deltaRequests("folder-inbox") > before)
				)
			);
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release("folder-inbox", { ids: true });
				})
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test and its mx sync run on.
			Effect.provide(TestClock.layer())
		));

	test("a folder deleted while mx sync reads it is skipped and named in mx status, sync goes on, and the next folder listing drops it", () =>
		Effect.gen(function* () {
			microsoft.addFolder("folder-seeds", "Seed library", "folder-root");
			microsoft.addFolder("folder-tools", "Tool shed", "folder-root");
			yield* cli("sync", "--once");
			const ended = microsoft.roundsEnded.length;
			const listed = idListings().length;
			microsoft.hold("folder-seeds");
			microsoft.hold("folder-tools", { ids: true });
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"the pass reading the folders it listed",
				() => microsoft.roundsEnded.length > ended
			);
			microsoft.removeFolder("folder-seeds");
			microsoft.release("folder-seeds");
			const lastError = (text: string) =>
				Effect.map(status, ({ output }) =>
					output.includes(`Last error: ${text}`)
				);
			yield* eventually(
				"the pass that skipped Seed library",
				lastError(
					"Skipped folder Seed library: Microsoft Graph refused the request with 404 ErrorItemNotFound"
				)
			);
			yield* eventually(
				"the check listing the folders",
				() => idListings().length > listed
			);
			microsoft.removeFolder("folder-tools");
			microsoft.release("folder-tools", { ids: true });
			yield* eventually(
				"the check that skipped Tool shed",
				lastError(
					"Skipped folder Tool shed: Microsoft Graph refused the request with 404 ErrorItemNotFound"
				)
			);
			yield* eventually(
				"the next pass",
				TestClock.adjust("60 seconds").pipe(Effect.andThen(lastError("none")))
			);
			yield* Fiber.interrupt(service);
			for (const folder of ["Seed library", "Tool shed"]) {
				expect(yield* refusal("search", { folder })).toContain(
					`No folder named ${folder}.`
				);
			}
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release("folder-seeds");
					microsoft.release("folder-tools", { ids: true });
				})
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test, its mx sync and mx status run on.
			Effect.provide(TestClock.layer())
		));

	test("a folder whose pages Graph answers in a form mx cannot read is skipped and named in mx status, the other folders sync, sync goes on, and the folder's changes arrive once Graph answers readably", () =>
		Effect.gen(function* () {
			microsoft.addFolder("folder-trellis", "Trellis", "folder-root");
			yield* cli("sync", "--once");
			const listed = idListings().length;
			microsoft.unreadable("folder-trellis");
			microsoft.unreadable("folder-trellis", { ids: true });
			for (const [parentFolderId, subject] of [
				["folder-inbox", "Bean poles"],
				["folder-trellis", "Trellis wire"],
			] as const) {
				microsoft.deliver({
					body: `${subject} are in.`,
					conversationId: "conversation-trellis",
					from: rosa,
					parentFolderId,
					received: "2026-10-11T08:00:00Z",
					subject,
				});
			}
			const service = yield* Effect.forkChild(cli("sync"));
			const lastError = (text: string) =>
				Effect.map(status, ({ output }) =>
					output.includes(`Last error: ${text}`)
				);
			yield* eventually(
				"the pass that skipped Trellis",
				lastError(
					"Skipped folder Trellis: Microsoft Graph answered a page mx cannot read"
				)
			);
			expect(yield* tool("search", { query: "bean poles" })).toMatch(
				beanPolesInInboxLine
			);
			yield* eventually("the check listing the ids of Trellis", () =>
				Arr.some(idListings().slice(listed), (request) =>
					request.url.pathname.includes("/folder-trellis/")
				)
			);
			microsoft.readable("folder-trellis");
			microsoft.readable("folder-trellis", { ids: true });
			yield* eventually(
				"the next pass",
				TestClock.adjust("60 seconds").pipe(Effect.andThen(lastError("none")))
			);
			expect(yield* tool("search", { query: "trellis wire" })).toMatch(
				trellisWireLine
			);
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.readable("folder-trellis");
					microsoft.readable("folder-trellis", { ids: true });
					microsoft.removeFolder("folder-trellis");
				})
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test, its mx sync and mx status run on.
			Effect.provide(TestClock.layer())
		));

	test("a check against Graph that fails runs again an hour later, not a day later", () =>
		Effect.gen(function* () {
			const asked = inboxIdListings();
			const listed = idListings().length;
			microsoft.hold("folder-inbox", { ids: true });
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"the check listing the folders",
				() => idListings().length > listed
			);
			microsoft.outage = 503;
			microsoft.release("folder-inbox", { ids: true });
			yield* eventually(
				"the last try of the listing during the outage",
				TestClock.adjust("5 seconds").pipe(
					Effect.andThen(settleBriefly),
					Effect.map(() => inboxIdListings() > asked + 3)
				)
			);
			microsoft.outage = 0;
			const failed = inboxIdListings();
			yield* TestClock.adjust("50 minutes");
			yield* settle;
			expect(inboxIdListings()).toBe(failed);
			yield* eventually(
				"the check an hour after it failed",
				TestClock.adjust("5 minutes").pipe(
					Effect.andThen(settleBriefly),
					Effect.map(() => inboxIdListings() > failed)
				)
			);
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.outage = 0;
					microsoft.release("folder-inbox", { ids: true });
				})
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test and its mx sync run on.
			Effect.provide(TestClock.layer())
		));

	test("a tool call on a message Graph no longer holds removes it from the store and says so", () =>
		Effect.gen(function* () {
			const notice = microsoft.deliver({
				body: "The water trough is fixed.",
				conversationId: "conversation-trough",
				from: rosa,
				parentFolderId: "folder-inbox",
				received: "2026-10-09T09:00:00Z",
				subject: "Trough fixed",
			});
			yield* cli("sync", "--once");
			const id = idOf(yield* tool("search", { query: "trough" }), "Trough");
			microsoft.purge(notice.id);
			expect(lines(yield* refusal("message", { full: true, id })).at(-1)).toBe(
				`#${id} is no longer in the mailbox.`
			);
			expect(yield* refusal("message", { id })).toContain(`No message #${id}.`);
		}));

	test("update_draft and delete_draft on a draft deleted in Outlook after mx checked it say it is no longer in the mailbox and remove it from the store", () =>
		Effect.gen(function* () {
			/** A new draft that Graph deletes for good right after its next read; answers its local id. */
			const vanishing = (subject: string) =>
				Effect.gen(function* () {
					const id = idOf(
						yield* tool("draft", { kind: "new", subject }),
						subject
					);
					const drafted = Arr.findFirst(
						microsoft.inFolder("folder-drafts"),
						(draft) => draft.subject === subject
					);
					microsoft.vanishAfterRead(Option.getOrThrow(drafted).id);
					return id;
				});
			const edited = yield* vanishing("Gate code for the allotment");
			expect(
				yield* refusal("update_draft", {
					body: "The code is 4321.",
					id: edited,
				})
			).toBe(`#${edited} is no longer in the mailbox.`);
			const discarded = yield* vanishing("Spare key for the shed");
			expect(yield* refusal("delete_draft", { id: discarded })).toBe(
				`#${discarded} is no longer in the mailbox.`
			);
			for (const id of [edited, discarded]) {
				expect(yield* refusal("message", { id })).toContain(
					`No message #${id}.`
				);
			}
		}));

	test("while a pass runs for many minutes, as when Graph throttles every request, mx status reports sync running", () =>
		Effect.gen(function* () {
			microsoft.throttleEach = 3;
			microsoft.retryAfter = 50;
			const ended = microsoft.roundsEnded.length;
			const asked = microsoft.graphRequests().length;
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"a throttled answer",
				() => microsoft.graphRequests().length > asked
			);
			for (let minute = 0; minute < 11; minute += 1) {
				// Answers in flight arrive before the clock moves past their deadlines.
				yield* settleBriefly;
				yield* TestClock.adjust("1 minute");
			}
			const { output } = yield* status;
			expect(microsoft.roundsEnded.length - ended).toBeLessThan(
				allFolders.length
			);
			expect(lines(output)[0]).toMatch(runningLine);
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.throttleEach = 0;
					microsoft.retryAfter = 1;
				})
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test, its mx sync and mx status run on.
			Effect.provide(TestClock.layer())
		));

	test("while Graph fails for hours, read tools say how old the mail is and name the last error, and mx status exits non-zero", () =>
		Effect.gen(function* () {
			const threeHoursAgo =
				Temporal.Now.instant().epochMilliseconds - 3 * 60 * 60 * 1000;
			yield* TestClock.setTime(threeHoursAgo);
			const service = yield* Effect.forkChild(cli("sync"));
			yield* eventually(
				"a pass 3 hours ago",
				Effect.map(call("search", { limit: 1 }), ({ text }) =>
					text.startsWith("⚠ Mail last synced 3 h ago")
				)
			);
			microsoft.outage = 503;
			yield* TestClock.setTime(Temporal.Now.instant().epochMilliseconds);
			yield* eventually(
				"the outage in the heartbeat",
				TestClock.adjust("5 seconds").pipe(
					Effect.andThen(status),
					Effect.map(({ output: report }) =>
						report.includes("Last error: Microsoft")
					)
				)
			);
			expect(lines(yield* tool("search", { limit: 1 }))[0]).toBe(
				"⚠ Mail last synced 3 h ago. Last error: Microsoft Graph answered 503 ServiceUnavailable. Run mx status."
			);
			const { exit, output } = yield* status;
			expect(Exit.isFailure(exit)).toBe(true);
			expect(lines(output)[0]).toMatch(runningLine);
			microsoft.outage = 0;
			yield* eventually(
				"a pass after the outage",
				TestClock.adjust("1 minute").pipe(
					Effect.andThen(status),
					Effect.map(({ output: report }) =>
						report.includes("Last error: none")
					)
				)
			);
			yield* Fiber.interrupt(service);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.outage = 0;
				})
			),
			// @effect-diagnostics-next-line strictEffectProvide:off - the test clock this one test, its mx sync and mx status run on.
			Effect.provide(TestClock.layer())
		));

	test("a store that mx 0.1.0 wrote opens: mx records its schema as the first migration and keeps every folder, message, local id and search", () =>
		Effect.gen(function* () {
			const { database, system } = ownStore("store-0.1.0");
			yield* (yield* FileSystem.FileSystem).makeDirectory(dirname(database), {
				recursive: true,
			});
			const received = Temporal.Instant.from(
				"2026-10-03T09:30:00Z"
			).epochMilliseconds;
			yield* withDatabase(database, (db) => {
				db.run(schemaBeforeMigrations);
				db.run(
					"INSERT INTO folders (id, parent_id, name, path, sent, delta_link) VALUES ('folder-inbox', 'root', 'Inbox', 'Inbox', 0, 'delta-link-inbox')"
				);
				// Local id 1 named a message that has since left the store; the seed order keeps its id 2.
				db.run(
					"INSERT INTO local_ids (id, graph_id) VALUES (1, 'message-gone'), (2, 'message-seeds')"
				);
				db.run(
					`INSERT INTO messages (id, graph_id, folder_id, conversation_id, internet_message_id, from_name, from_address, to_list, cc_list, bcc_list, subject, received_at, sent_at, is_read, is_draft, flag, categories, importance, has_attachments, body)
					VALUES (2, 'message-seeds', 'folder-inbox', 'conversation-garden', NULL, 'Marta Example', 'marta@example.com', '[]', '[]', '[]', 'Garden supplies order', ${received}, ${received}, 0, 0, 'notFlagged', '[]', 'normal', 0, 'The seed order was approved this morning.')`
				);
			});
			const contents = withDatabase(database, (db) => ({
				folders: db.query("SELECT * FROM folders").all(),
				localIds: db.query("SELECT * FROM local_ids").all(),
				messages: db.query("SELECT * FROM messages").all(),
			}));
			const before = yield* contents;
			const found = yield* Effect.gen(function* () {
				const { client, stdio } = yield* connect();
				yield* Command.runWith(mx, { version: "0.0.0-test" })(["mcp"]).pipe(
					// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
					Effect.provide(stdio),
					// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of this mx mcp process.
					Effect.provide(system, { local: true }),
					Effect.forkScoped
				);
				return yield* client.call("search", { query: "approve" });
			}).pipe(Effect.scoped);
			expect(found.isError).toBe(false);
			expect(found.text).toMatch(seedOrderLine);
			expect(yield* recordedMigrations(database)).toEqual([
				{ id: 1, name: "initial" },
			]);
			expect(yield* contents).toEqual(before);
		}));

	test("a later migration runs once: the store records it, and the next start runs nothing", () =>
		Effect.gen(function* () {
			const { database } = ownStore("store-later");
			yield* (yield* FileSystem.FileSystem).makeDirectory(dirname(database), {
				recursive: true,
			});
			yield* onStore(database)(migrate(migrations));
			const links = withDatabase(database, (db) =>
				db.query("SELECT delta_link AS link FROM folders").all()
			);
			yield* withDatabase(database, (db) =>
				db.run(
					"INSERT INTO folders (id, parent_id, name, path, sent, delta_link) VALUES ('folder-inbox', 'root', 'Inbox', 'Inbox', 0, 'delta-link-1')"
				)
			);
			const withLater = { ...migrations, ...laterMigration };
			yield* onStore(database)(migrate(withLater));
			expect(yield* links).toEqual([{ link: null }]);
			const recorded = [
				{ id: 1, name: "initial" },
				{ id: 2, name: "resync_every_folder" },
			];
			expect(yield* recordedMigrations(database)).toEqual(recorded);
			yield* withDatabase(database, (db) =>
				db.run("UPDATE folders SET delta_link = 'delta-link-2'")
			);
			yield* onStore(database)(migrate(withLater));
			expect(yield* links).toEqual([{ link: "delta-link-2" }]);
			expect(yield* recordedMigrations(database)).toEqual(recorded);
		}));

	test("mx refuses a store that a newer mx migrated, says to run mx update, and changes nothing", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { database, system } = ownStore("store-newer");
			yield* fs.makeDirectory(dirname(database), { recursive: true });
			yield* onStore(database)(migrate({ ...migrations, ...laterMigration }));
			const before = Bun.hash(yield* fs.readFile(database));
			const failure = yield* Effect.flip(cliOn(system)("reindex"));
			expect(failure.message).toBe(
				"This mail store was written by a newer mx. Run mx update."
			);
			expect(Bun.hash(yield* fs.readFile(database))).toBe(before);
			expect(yield* recordedMigrations(database)).toEqual([
				{ id: 1, name: "initial" },
				{ id: 2, name: "resync_every_folder" },
			]);
		}));

	test("mx install without --agent and without a terminal fails, names the agents it can set up, and changes nothing", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const before = processes.commands.length;
			const { errors, exit } = yield* withStdinTerminal(false)(run("install"));
			expect(Exit.isFailure(exit)).toBe(true);
			expect(errors).toContain(`--agent: ${offeredAgents}.`);
			expect(processes.commands).toHaveLength(before);
			expect(yield* fs.exists(installed)).toBe(false);
		}));

	test("mx install fails before it changes anything when a chosen agent's config file is missing, and names that file", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* writeJson(claudeCodeConfig, claudeCodeSettings);
			const settings = yield* fs.readFileString(claudeCodeConfig);
			const before = processes.commands.length;
			const failure = yield* Effect.flip(
				cli("install", "--agent", "claude-code", "--agent", "codex")
			);
			expect(failure.message).toBe(
				`${codexConfig} does not exist. Open Codex once, then run mx install again.`
			);
			expect(yield* fs.readFileString(claudeCodeConfig)).toBe(settings);
			expect(processes.commands).toHaveLength(before);
			expect(yield* fs.exists(installed)).toBe(false);
		}));

	test("mx install without --agent asks which agents to set up, and the ones whose config file exists start selected", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { frames, system } = fakeTerminal(platform, ["return"]);
			const { exit } = yield* withStdinTerminal(true)(runOn(system)("install"));
			expect(Exit.isSuccess(exit)).toBe(true);
			const drawn = Arr.join(frames, "");
			expect(drawn).toContain("Claude Code");
			expect(drawn).toContain("Codex");
			expect(drawn.includes("Claude Desktop")).toBe(windows || mac);
			expect(yield* readJson(claudeCodeConfig)).toEqual({
				...claudeCodeSettings,
				mcpServers: {
					...claudeCodeSettings.mcpServers,
					mx: { ...claudeCodeSettings.mcpServers.mx, ...mxEntry },
				},
			});
			expect(yield* fs.exists(codexConfig)).toBe(false);
		}));

	test("mx install refuses a config.toml it cannot change without touching other settings, and writes nothing", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dotted =
				'model = "gpt-6.1-sol"\n\n[mcp_servers]\nmx.command = "/old/mx"\n';
			yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
			yield* fs.writeFileString(codexConfig, dotted);
			const before = processes.commands.length;
			const failure = yield* Effect.flip(cli("install", "--agent", "codex"));
			expect(failure.message).toContain(codexConfig);
			expect(yield* fs.readFileString(codexConfig)).toBe(dotted);
			expect(processes.commands).toHaveLength(before);
		}));

	test("mx install keeps what an agent saved to its config while mx install ran, and says to restart each agent it set up", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* writeJson(claudeCodeConfig, claudeCodeSettings);
			yield* fs.writeFileString(codexConfig, codexSettings);
			const saved = {
				...claudeCodeSettings,
				mcpServers: {
					...claudeCodeSettings.mcpServers,
					notes: { args: [], command: "notes" },
				},
				numStartups: 4,
			};
			const { output } = yield* cliOn(
				savedWhileInstalling((files) =>
					Effect.andThen(
						files.writeFileString(
							claudeCodeConfig,
							JSON.stringify(saved, null, 2)
						),
						files.writeFileString(
							codexConfig,
							`${codexSettings}\n[mcp_servers.notes]\ncommand = "notes"\n`
						)
					)
				)
			)("install", "--agent", "claude-code", "--agent", "codex");
			expect(yield* readJson(claudeCodeConfig)).toEqual({
				...saved,
				mcpServers: {
					...saved.mcpServers,
					mx: { ...saved.mcpServers.mx, ...mxEntry },
				},
			});
			const codex = yield* fs.readFileString(codexConfig);
			expect(codex).toContain('[mcp_servers.notes]\ncommand = "notes"');
			expect(codex).toContain(codexCommand);
			expect(lines(output).at(-1)).toBe(
				"Quit and reopen Claude Code and Codex now. An agent left open can write its old settings back and drop mx."
			);
		}));

	test("mx install, run twice, installs the binary, registers mx sync to start at sign-in, sets the command and args of one mx entry in each agent's config and keeps everything else, the entry's other keys too, and starts sync", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* writeJson(claudeCodeConfig, claudeCodeSettings);
			yield* fs.writeFileString(codexConfig, codexSettings);
			const before = processes.commands.length;
			yield* cli("install", "--agent", "claude-code", "--agent", "codex");
			yield* cli("install", "--agent", "codex", "--agent", "claude-code");
			expect((yield* fs.stat(installed)).size).toBe(
				(yield* fs.stat(process.execPath)).size
			);
			const once = [...syncCommands.register, ...syncCommands.reload];
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual([...once, ...once]);
			expect(yield* readJson(claudeCodeConfig)).toEqual({
				...claudeCodeSettings,
				mcpServers: {
					...claudeCodeSettings.mcpServers,
					mx: { ...claudeCodeSettings.mcpServers.mx, ...mxEntry },
				},
			});
			expect(yield* fs.readFileString(codexConfig)).toBe(codexWithMx);
		}));

	test(
		"mx install says how to put ~/.local/bin on PATH when the shell lacks it, and says nothing once it is there",
		() =>
			Effect.gen(function* () {
				const folder = dirname(installed);
				const { output: lacking } = yield* cli("install", "--agent", "codex");
				expect(lines(lacking)).toContain(
					`${folder} is not on your PATH. Add it with echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${mac ? "~/.zprofile" : "~/.bashrc"}, then open a new terminal to run mx.`
				);
				const { output: holding } = yield* cliOn(
					platformWith({
						...environment,
						PATH: `${environment.PATH}:${folder}`,
					})
				)("install", "--agent", "codex");
				expect(holding).not.toContain("is not on your PATH");
			}),
		{
			because: "mx install puts the program folder on PATH itself on Windows",
			systems: ["darwin", "linux"],
		}
	);

	test(
		"mx install writes the systemd user unit that runs the installed binary and counts a stop as a clean exit, and makes the binary executable",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				expect((yield* fs.stat(installed)).mode % 0o1000).toBe(0o755);
				const unit = lines(yield* fs.readFileString(unitFile));
				expect(unit).toContain(`ExecStart="${installed}" sync`);
				expect(unit).toContain("SuccessExitStatus=130");
			}),
		{ because: "systemd and file modes are Linux's", systems: ["linux"] }
	);

	test(
		"mx install writes a LaunchAgent that runs the installed binary at sign-in, starts it again at most every 5 minutes after it fails, and logs to ~/Library/Logs/mx, and makes the binary executable",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				expect((yield* fs.stat(installed)).mode % 0o1000).toBe(0o755);
				// launchd refuses a LaunchAgent that its group or others can write.
				expect((yield* fs.stat(agentFile)).mode % 0o1000).toBe(0o644);
				const plutil = yield* Effect.sync(() =>
					Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", agentFile], {
						stderr: "inherit",
					})
				);
				expect(plutil.exitCode).toBe(0);
				expect(yield* parseJson(plutil.stdout.toString())).toEqual({
					KeepAlive: { SuccessfulExit: false },
					Label: agentLabel,
					ProgramArguments: [installed, "sync"],
					RunAtLoad: true,
					StandardErrorPath: join(stateFolder, "sync.log"),
					StandardOutPath: join(stateFolder, "sync.log"),
					ThrottleInterval: 300,
				});
			}),
		{ because: "plutil and launchd are macOS's", systems: ["darwin"] }
	);

	test(
		"mx install writes mxw.exe, the installed exe marked a Windows GUI program, and mxw.exe runs",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const exe = yield* fs.readFile(installed);
				// readFile answers a Buffer, whose slice shares its bytes; this copies them.
				const marked = new Uint8Array(exe);
				new DataView(marked.buffer).setUint16(
					subsystemAt(exe),
					guiSubsystem,
					true
				);
				expect(subsystem(exe)).toBe(consoleSubsystem);
				expect(Buffer.from(yield* fs.readFile(background)).equals(marked)).toBe(
					true
				);
				const started = Bun.spawn([background, "--version"], {
					stderr: "pipe",
					stdin: "ignore",
					stdout: "pipe",
				});
				const [code, version] = yield* Effect.promise(() =>
					Promise.all([started.exited, new Response(started.stdout).text()])
				);
				expect(code).toBe(0);
				// mx install copied the Bun that runs the tests, as mx.exe and mxw.exe.
				expect(version.trim()).toBe(Bun.version);
			}),
		{ because: "it runs the installed exe", systems: ["win32"] }
	);

	test("with CLAUDE_CONFIG_DIR set, mx install writes Claude Code's .claude.json and settings.json in that folder and leaves ~/.claude.json alone", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const folder = `${home}/claude-work`;
			yield* fs.makeDirectory(folder, { recursive: true });
			yield* writeJson(`${folder}/.claude.json`, { numStartups: 1 });
			const before = yield* fs.readFileString(claudeCodeConfig);
			yield* cliOn(platformWith({ ...environment, CLAUDE_CONFIG_DIR: folder }))(
				"install",
				"--agent",
				"claude-code"
			);
			expect(yield* readJson(`${folder}/.claude.json`)).toEqual({
				mcpServers: { mx: mxEntry },
				numStartups: 1,
			});
			expect(yield* readJson(`${folder}/settings.json`)).toMatchObject({
				permissions: {
					ask: ["mcp__mx__send", "mcp__mx__delete", "mcp__mx__delete_folder"],
				},
			});
			expect(yield* fs.readFileString(claudeCodeConfig)).toBe(before);
		}));

	test("on a machine that never synced, mx install syncs in the foreground before it starts mx sync, on a terminal in one line that counts the messages and the time left", () =>
		Effect.gen(function* () {
			const { frames, system } = fakeTerminal(
				yield* neverSynced("first-sync-terminal"),
				[]
			);
			const total = mailboxSize();
			const deltasAtEachStart: number[] = [];
			processes.onSpawn = () => {
				deltasAtEachStart.push(graphRequests("/messages/delta").length);
			};
			microsoft.deltaDelay = Duration.seconds(30);
			const { output } = yield* cliOn(system)(
				"install",
				"--agent",
				"claude-code"
			).pipe(onTestClock, withStdoutTerminal(true));
			expect(frames[0]).toBe(
				`\rSyncing 6 folders: 0 of ${total} messages\u001b[K`
			);
			expect(Arr.some(frames, (frame) => timeLeft.test(frame))).toBe(true);
			expect(
				Arr.every(
					frames.slice(0, -1),
					(frame) => frame.startsWith("\r") && !frame.includes("\n")
				)
			).toBe(true);
			expect(frames.slice(-2)).toEqual([
				`\rSynced 6 folders: ${total} messages saved, 0 removed.\u001b[K`,
				"\n",
			]);
			expect(deltasAtEachStart.at(-1)).toBe(
				graphRequests("/messages/delta").length
			);
			expect(lines(output)).toContain("Started mx sync.");
		}).pipe(Effect.ensuring(paceAsBefore)));

	test("without a terminal, the first sync prints a line when it starts, then one at most every 30 seconds, and the summary", () =>
		Effect.gen(function* () {
			const { frames, system } = fakeTerminal(
				yield* neverSynced("first-sync-plain"),
				[]
			);
			const total = mailboxSize();
			const before = graphRequests("/messages/delta").length;
			microsoft.deltaDelay = Duration.seconds(20);
			const { output } = yield* cliOn(system)(
				"install",
				"--agent",
				"claude-code"
			).pipe(onTestClock, withStdoutTerminal(false));
			const pages = graphRequests("/messages/delta").length - before;
			const progress = Arr.filter(lines(output), (line) =>
				line.startsWith("Syncing ")
			);
			expect(progress[0]).toBe(`Syncing 6 folders: 0 of ${total} messages`);
			expect(progress.length).toBeGreaterThan(1);
			expect(progress.length).toBeLessThan(pages);
			expect(Arr.every(progress.slice(1), (line) => timeLeft.test(line))).toBe(
				true
			);
			expect(lines(output)).toContain(
				`Synced 6 folders: ${total} messages saved, 0 removed.`
			);
			expect(frames).toEqual([]);
		}).pipe(Effect.ensuring(paceAsBefore)));

	test("mx install stopped during the first sync keeps the folders that finished, and the next mx install resumes them from their delta links and syncs only the rest", () =>
		Effect.gen(function* () {
			const system = yield* neverSynced("first-sync-resume");
			const others = Arr.filter(
				allFolders,
				(folder) => folder !== "folder-inbox"
			);
			const ended = microsoft.roundsEnded.length;
			microsoft.hold("folder-inbox");
			const stopped = yield* Effect.forkChild(
				withStdoutTerminal(false)(
					cliOn(system)("install", "--agent", "claude-code")
				)
			);
			yield* eventually("every folder but Inbox synced", () =>
				Arr.every(others, (folder) =>
					microsoft.roundsEnded.slice(ended).includes(folder)
				)
			);
			yield* settleBriefly;
			yield* Fiber.interrupt(stopped);
			microsoft.release("folder-inbox");
			const asked = microsoft.graphRequests().length;
			const { output } = yield* withStdoutTerminal(false)(
				cliOn(system)("install", "--agent", "claude-code")
			);
			const deltas = Arr.filter(
				microsoft.graphRequests().slice(asked),
				(request) => request.url.pathname.endsWith("/messages/delta")
			);
			const resumed = (folder: string) =>
				Arr.map(
					Arr.filter(deltas, (request) =>
						request.url.pathname.includes(`/${folder}/`)
					),
					(request) => request.url.searchParams.has("$deltatoken")
				);
			for (const folder of others) {
				expect(resumed(folder)).toEqual([true]);
			}
			expect(resumed("folder-inbox")[0]).toBe(false);
			expect(lines(output)).toContain(
				`Syncing 1 folder: 0 of ${microsoft.inFolder("folder-inbox").length} messages`
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					microsoft.release("folder-inbox");
				})
			)
		));

	test("on macOS, mx install that fails after it registered mx sync, as when Microsoft refuses the sign-in during the first sync, leaves the LaunchAgent loaded", () =>
		onMac(
			Effect.gen(function* () {
				const system = yield* neverSynced("first-sync-refused");
				yield* cli("install", "--agent", "codex");
				microsoft.refuseRefresh = true;
				const failure = yield* Effect.flip(
					withStdoutTerminal(false)(
						cliOn(system)("install", "--agent", "claude-code")
					)
				);
				expect(failure.message).toContain("Run mx login.");
				expect(processes.loaded.has(agentTarget)).toBe(true);
			}).pipe(Effect.ensuring(acceptRefresh))
		));

	test("on macOS, mx install loads the LaunchAgent again only once launchd has removed the one it unloaded", () =>
		onMac(
			Effect.gen(function* () {
				yield* cli("install", "--agent", "codex");
				processes.removalLag = 3;
				yield* cli("install", "--agent", "codex");
				expect(processes.loaded.has(agentTarget)).toBe(true);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						processes.removalLag = 0;
					})
				)
			)
		));

	test("mx install keeps the tool approvals each agent has, presets the recommended ones only where none is set, and writes Claude Code's through a symlink", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.writeFileString(codexConfig, codexSendApproved);
			yield* fs.makeDirectory(`${home}/dotfiles/claude`, { recursive: true });
			yield* writeJson(dotfile, userSettings);
			yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
			yield* fs.remove(claudeCodeSettingsFile, { force: true });
			yield* fs.symlink(dotfile, claudeCodeSettingsFile);
			yield* cli("install", "--agent", "codex", "--agent", "claude-code");
			yield* cli("install", "--agent", "claude-code", "--agent", "codex");
			expect(yield* fs.readFileString(codexConfig)).toBe(
				codexWithMx.replace(
					codexApprovals(recommended),
					codexApprovals([
						["send", "approve"],
						...Arr.filter(recommended, ([name]) => name !== "send"),
					])
				)
			);
			expect(yield* fs.readLink(claudeCodeSettingsFile)).toBe(dotfile);
			expect(yield* readJson(dotfile)).toEqual({
				model: "opus",
				permissions: {
					allow: [
						"Bash(ls *)",
						...Arr.map(
							Arr.filter(recommended, ([, mode]) => mode === "approve"),
							([name]) => `mcp__mx__${name}`
						),
					],
					ask: ["mcp__mx__send", "mcp__mx__delete_folder"],
					deny: ["mcp__mx__delete"],
				},
			});
		}));

	test("mx install on Windows tells how to make Claude Desktop write its config when it has none", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				onWindows(cli("install", "--agent", "claude-desktop"))
			);
			expect(failure.message).toBe(
				`${desktopConfig} does not exist. In Claude Desktop, open Settings › Developer › Edit Config, then run mx install again.`
			);
		}));

	test("mx install on Windows writes mx.exe into mcpServers.mx of Claude Desktop's config and keeps its other settings", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const settings = {
				globalShortcut: "Ctrl+Space",
				isUsingBuiltInNodeForMcp: true,
			};
			yield* fs.makeDirectory(dirname(desktopConfig), { recursive: true });
			yield* writeJson(desktopConfig, settings);
			yield* onWindows(cli("install", "--agent", "claude-desktop"));
			expect(yield* readJson(desktopConfig)).toEqual({
				...settings,
				mcpServers: {
					mx: { args: ["mcp"], command: join(windowsFolder, "mx.exe") },
				},
			});
		}));

	test("mx install on Windows that stops while it writes the new mx.exe leaves the installed one whole", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const exe = join(windowsFolder, "mx.exe");
			const before = new TextEncoder().encode("synthetic installed mx.exe");
			yield* fs.makeDirectory(windowsFolder, { recursive: true });
			yield* fs.writeFile(exe, before);
			const exit = yield* Effect.exit(
				onWindows(
					cliOn(cutOffWrites(windowsFolder))("install", "--agent", "codex")
				)
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(yield* fileSha256(exe)).toBe(sha256(before));
		}));

	test("double-clicked on Windows, mx plays the banner, runs mx install, and waits for Enter before its console closes", () =>
		doubleClicked(
			Effect.gen(function* () {
				yield* writeJson(claudeCodeConfig, claudeCodeSettings);
				const { frames, press, system } = fakeTerminal(platform, ["return"]);
				const started = yield* Effect.forkChild(runOn(system)());
				yield* eventually(
					"mx to ask for Enter",
					() => frames.at(-1) === "Press Enter to close."
				);
				yield* settleBriefly;
				expect(started.pollUnsafe()).toBeUndefined();
				yield* press("return");
				const { exit, output } = yield* Fiber.join(started);
				expect(Exit.isSuccess(exit)).toBe(true);
				expect(frames[0]).toStartWith("\u001b[?25l");
				expect(Arr.join(frames, "")).toContain("Which agents should use mx?");
				expect(lines(output)).toContain(
					`Registered mx with Claude Code in ${claudeCodeConfig}.`
				);
				expect(lines(output)).toContain("Started mx sync.");
			})
		));

	test("double-clicked on Windows, mx stopped while it installs waits for Enter before its console closes", () =>
		doubleClicked(
			Effect.gen(function* () {
				const { frames, press, system } = fakeTerminal(platform, []);
				const started = yield* Effect.forkChild(runOn(system)());
				yield* eventually("mx to ask which agents to set up", () =>
					Arr.join(frames, "").includes("Which agents should use mx?")
				);
				// Ctrl+C makes Bun's runtime interrupt mx as this does.
				const stopping = yield* Effect.forkChild(Fiber.interrupt(started));
				yield* eventually(
					"mx to ask for Enter",
					() => frames.at(-1) === "Press Enter to close."
				);
				yield* settleBriefly;
				expect(stopping.pollUnsafe()).toBeUndefined();
				yield* press("return");
				yield* Fiber.join(stopping);
			})
		));

	test("double-clicked on Windows, a failed mx install says why and waits until the input ends before its console closes", () =>
		doubleClicked(
			Effect.gen(function* () {
				// A machine of its own, where no agent has a config yet.
				const root = join(home, "double-clicked");
				const { close, frames, system } = fakeTerminal(
					platformWith({
						...environment,
						APPDATA: join(root, "Roaming"),
						HOME: root,
						LOCALAPPDATA: join(root, "Local"),
						USERPROFILE: root,
					}),
					["space", "return"]
				);
				const started = yield* Effect.forkChild(runOn(system)());
				yield* eventually(
					"mx to ask for Enter",
					() => frames.at(-1) === "Press Enter to close."
				);
				yield* settleBriefly;
				expect(started.pollUnsafe()).toBeUndefined();
				yield* close;
				const { errors, exit } = yield* Fiber.join(started);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(errors).toBe(
					`mx: ${join(root, "Roaming", "Claude", "claude_desktop_config.json")} does not exist. In Claude Desktop, open Settings › Developer › Edit Config, then run mx install again.`
				);
			})
		));

	test("mx update installs a newer signed release: it checks the signature, the size and the sha256, replaces the binary and restarts sync", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				releases.publish({ binary: newBinary, version: later(1) })
			);
			const before = processes.commands.length;
			const { output } = yield* cli("update");
			expect(output).toContain(`Updated mx to ${later(1)}`);
			expect(yield* fileSha256(installed)).toBe(sha256(newBinary));
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual(syncCommands.restart);
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
			expect(yield* fileSha256(installed)).toBe(sha256(newBinary));
		}));

	test("mx update refuses a release that is not newer than the running binary", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				releases.publish({ binary: otherBinary, version: running })
			);
			const { output } = yield* cli("update");
			expect(output).toContain(`${running} is the newest release`);
			expect(downloads(running)).toBe(0);
			expect(yield* fileSha256(installed)).toBe(sha256(newBinary));
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
			expect(yield* fileSha256(installed)).toBe(sha256(newBinary));
		}));

	test("after mx sync stops, read tools say when mail last synced, and mx status exits non-zero", () =>
		Effect.gen(function* () {
			const threeHoursAgo =
				Temporal.Now.instant().epochMilliseconds - 3 * 60 * 60 * 1000;
			yield* Effect.gen(function* () {
				yield* TestClock.setTime(threeHoursAgo);
				const service = yield* Effect.forkChild(cli("sync"));
				yield* eventually(
					"a pass 3 hours ago",
					Effect.map(call("search", { limit: 1 }), ({ text }) =>
						text.startsWith("⚠ Mail last synced 3 h ago")
					)
				);
				yield* Fiber.interrupt(service);
			}).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off - the test clock the stopped mx sync ran on.
				Effect.provide(TestClock.layer())
			);
			const [warning, ...answer] = lines(yield* tool("search", { limit: 1 }));
			expect(warning).toBe(
				"⚠ Mail last synced 3 h ago and mx sync is not running. Run mx status."
			);
			expect(answer).toHaveLength(1);
			for (const name of ["thread", "message", "attachment"]) {
				expect(
					lines(yield* tool(name, { id: idOf(answer[0] ?? "", "#") }))[0]
				).toBe(warning);
			}
			const { exit, output } = yield* status;
			expect(Exit.isFailure(exit)).toBe(true);
			expect(lines(output)[0]).toBe(
				"mx sync: not running, last heard from 3 h ago"
			);
		}));

	test("when Microsoft refuses the saved sign-in, mx sync records Sign-in expired before it stops, mx status shows it, and read tools say so", () =>
		Effect.gen(function* () {
			microsoft.refuseRefresh = true;
			const failure = yield* Effect.flip(cli("sync"));
			expect(failure.message).toContain("Run mx login.");
			const { exit, output } = yield* status;
			expect(Exit.isFailure(exit)).toBe(true);
			expect(lines(output)).toContain(
				"Last error: Sign-in expired. Run mx login."
			);
			expect(lines(yield* tool("search", { limit: 1 }))[0]).toBe(
				"⚠ Sign-in expired. Run mx login."
			);
		}).pipe(Effect.ensuring(acceptRefresh)));

	test("a refused refresh token fails loudly with run mx login, and no token is ever printed", () =>
		Effect.gen(function* () {
			microsoft.refuseRefresh = true;
			const failure = yield* Effect.flip(cli("sync", "--once"));
			expect(failure.message).toContain("Run mx login.");
			expect(String(failure)).not.toMatch(secrets_);
			expect(printed.length).toBeGreaterThan(0);
			expect(Arr.join(printed, "\n")).not.toMatch(secrets_);
		}).pipe(Effect.ensuring(acceptRefresh)));
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
			expect(yield* fs.exists(join(dataFolder, "mx.sqlite"))).toBe(true);
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
			for (const path of mxFiles) {
				expect(prompt).toContain(path);
			}
			expect(prompt).toContain("the saved sign-in");
			for (const entry of [
				`mcpServers.mx in ${claudeCodeConfig}`,
				`the permission rules that name mx in ${claudeCodeSettingsFile}`,
				`[mcp_servers.mx] with its tool tables in ${codexConfig}`,
				...(windows
					? [
							`the mx value under ${runKey}`,
							`mcpServers.mx in ${desktopConfig}`,
						]
					: []),
			]) {
				expect(prompt).toContain(entry);
			}
			expect(output).toBe("mx uninstall removed nothing.");
			expect(processes.commands).toHaveLength(before);
			expect(yield* fs.exists(installed)).toBe(true);
		}));

	test("mx uninstall --yes stops sync first, then removes the unit, mx from each agent with every Claude Code rule that names mx, the binary, the client id, the mail store, the sign-in, the cache and the state folder", () =>
		Effect.gen(function* () {
			secrets.machine = "store";
			const fs = yield* FileSystem.FileSystem;
			const before = processes.commands.length;
			yield* writeJson(dotfile, {
				model: "opus",
				permissions: {
					allow: ["Bash(ls *)", "mcp__mx__search", "mcp__mx__*"],
					ask: ["mcp__mx__send", "mcp__mx"],
					deny: ["mcp__mx__delete", "mcp__other__send"],
				},
			});
			let signedInWhenSyncStopped = false;
			processes.onSpawn = () => {
				signedInWhenSyncStopped ||= secrets.entries.has("mx/refresh-token");
			};
			const { output } = yield* cli("uninstall", "--yes");
			processes.onSpawn = undefined;
			expect(
				Arr.map(processes.commands.slice(before), (command) =>
					Arr.join(command, " ")
				)
			).toEqual(syncCommands.remove);
			expect(signedInWhenSyncStopped).toBe(true);
			const { mx: _, ...others } = claudeCodeSettings.mcpServers;
			expect(yield* readJson(claudeCodeConfig)).toEqual({
				...claudeCodeSettings,
				mcpServers: others,
			});
			expect(yield* fs.readFileString(codexConfig)).toBe(codexWithoutMx);
			expect(yield* readJson(dotfile)).toEqual({
				model: "opus",
				permissions: { allow: ["Bash(ls *)"], deny: ["mcp__other__send"] },
			});
			// On Windows, the mx mcp these tests talk to holds the mail store open, so it stays.
			for (const path of mxFiles) {
				expect(yield* fs.exists(path)).toBe(windows && path === dataFolder);
			}
			expect(
				output.includes(
					`Could not delete ${dataFolder} while mx mcp has it open.`
				)
			).toBe(windows);
			expect(secrets.entries.has("mx/refresh-token")).toBe(false);
		}));

	test(
		"mx install from the Arch package copies no binary and writes no unit, enables the package's unit and registers /usr/bin/mx",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
				yield* fs.writeFileString(codexConfig, codexSettings);
				const before = processes.commands.length;
				yield* fromPackage(cli("install", "--agent", "codex"));
				expect(
					Arr.map(processes.commands.slice(before), (command) =>
						Arr.join(command, " ")
					)
				).toEqual([
					"systemctl --user daemon-reload",
					"systemctl --user enable mx-sync.service",
					"systemctl --user restart --no-block mx-sync.service",
				]);
				expect(yield* fs.exists(installed)).toBe(false);
				expect(yield* fs.exists(unitFile)).toBe(false);
				expect(yield* fs.readFileString(codexConfig)).toContain(
					`command = "${packaged}"`
				);
			}),
		{ because: "the Arch package is for Arch Linux", systems: ["linux"] }
	);

	test(
		"mx update from the Arch package refuses, names the AUR package to update, and fetches no release",
		() =>
			Effect.gen(function* () {
				const asked = Arr.filter(microsoft.received, (request) =>
					isReleaseRequest(request.url)
				).length;
				const failure = yield* Effect.flip(fromPackage(cli("update")));
				expect(failure.message).toContain("mx-mail-bin");
				expect(
					Arr.filter(microsoft.received, (request) =>
						isReleaseRequest(request.url)
					)
				).toHaveLength(asked);
			}),
		{ because: "the Arch package is for Arch Linux", systems: ["linux"] }
	);

	test(
		"mx uninstall --yes from the Arch package disables the unit and leaves the binary and the unit to pacman -R mx-mail-bin",
		() =>
			Effect.gen(function* () {
				const before = processes.commands.length;
				const { output } = yield* fromPackage(cli("uninstall", "--yes"));
				expect(
					Arr.map(processes.commands.slice(before), (command) =>
						Arr.join(command, " ")
					)
				).toEqual([
					"systemctl --user disable --now mx-sync.service",
					"systemctl --user daemon-reload",
				]);
				expect(output).toContain("pacman -R mx-mail-bin");
				expect(output).not.toContain(`Removed ${packaged}`);
			}),
		{ because: "the Arch package is for Arch Linux", systems: ["linux"] }
	);

	test("mx install on Windows adds the program folder to the user PATH once and keeps every other entry, and mx uninstall takes out only that folder", () =>
		onWindows(
			Effect.gen(function* () {
				const others =
					"%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\Zoë\\bin;;C:\\Tools\\";
				processes.userPath = others;
				const { output } = yield* cli("install", "--agent", "codex");
				expect(output).toContain(
					`Added ${windowsFolder} to your PATH. Open a new terminal to run mx.`
				);
				yield* cli("install", "--agent", "codex");
				expect(processes.userPath).toBe(`${others};${windowsFolder}`);
				yield* cli("uninstall", "--yes");
				expect(processes.userPath).toBe(others);
			})
		));

	test("on Windows, mx uninstall stops mx sync with the processes it started before it deletes anything", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* cli("install", "--agent", "codex");
				const before = processes.commands.length;
				let installedWhenSyncStopped = false;
				processes.onSpawn = () => {
					installedWhenSyncStopped ||= Bun.file(background).size > 0;
				};
				yield* cli("uninstall", "--yes");
				processes.onSpawn = undefined;
				expect(Arr.join(processes.commands[before] ?? [], " ")).toBe(
					stopBackground
				);
				expect(installedWhenSyncStopped).toBe(true);
				expect(yield* fs.exists(background)).toBe(false);
			})
		));

	test("on Windows, mx install stops the mx sync that runs once it is gone and starts the new one", () =>
		onWindows(
			Effect.gen(function* () {
				yield* cli("install", "--agent", "codex");
				const old = [...processes.syncs];
				const { output } = yield* cli("install", "--agent", "codex");
				expect(lines(output)).toContain("Started mx sync.");
				expect(processes.syncs.size).toBe(1);
				expect(Arr.some(old, (pid) => processes.syncs.has(pid))).toBe(false);
			})
		));

	test("on Windows, mx install fails and names the mxw.exe that still runs after mx stopped it, and starts no second mx sync", () =>
		onWindows(
			Effect.gen(function* () {
				yield* cli("install", "--agent", "codex");
				const unstopped = [...processes.syncs];
				for (const pid of unstopped) {
					processes.unstoppable.add(pid);
				}
				const failure = yield* Effect.flip(cli("install", "--agent", "codex"));
				expect(failure.message).toBe(
					`Could not stop mx sync: mxw.exe still runs as PID ${Arr.join(Arr.map(unstopped, String), ", ")}. End it in Task Manager, then try again.`
				);
				expect([...processes.syncs]).toEqual(unstopped);
			}).pipe(Effect.ensuring(Effect.sync(() => processes.unstoppable.clear())))
		));

	test("on Windows, mx install while an agent's mx mcp runs the mx.exe an earlier install moved aside installs, and the next install once the agent quit deletes that copy", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const inUse = new Set<string>();
				const install = cliOn(whileRunning(inUse));
				const movedAside = Effect.map(
					fs.readDirectory(windowsFolder),
					(names) =>
						Arr.map(
							Arr.filter(names, (name) => name.includes(".old")),
							(name) => join(windowsFolder, name)
						)
				);
				yield* install("install", "--agent", "codex");
				// Claude Desktop starts mx mcp from the installed mx.exe.
				inUse.add(join(windowsFolder, "mx.exe"));
				yield* install("install", "--agent", "codex");
				yield* install("install", "--agent", "codex");
				expect(yield* movedAside).toEqual([...inUse]);
				inUse.clear();
				yield* install("install", "--agent", "codex");
				expect(yield* movedAside).toEqual([]);
			})
		));

	test("mx uninstall run from the installed mx.exe deletes mxw.exe and the copies a reinstall or an update moved aside at once, and the program folder once it exits", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const exe = join(windowsFolder, "mx.exe");
				const movedAside = [
					join(windowsFolder, "mx.old.exe"),
					join(
						windowsFolder,
						"mx.old-6f1c2a1e-0d7b-4c4e-9a59-2f0c1b9d7e31.exe"
					),
					join(
						windowsFolder,
						"mxw.old-7d1e9a3b-2c4f-4e8a-b6d0-1f3e5a7c9b24.exe"
					),
				];
				yield* cli("install", "--agent", "codex");
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
				// On Windows, the mx mcp these tests talk to holds the mail store open, so only the program counts here.
				expect(output).not.toContain(`Could not delete ${windowsFolder}`);
			})
		));

	test("on Windows, mx install selects Claude Desktop from the Microsoft Store when its package holds its config, and sets up mx there, and mx uninstall takes mx out", () =>
		onWindows(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				// A machine of its own, where the packaged Claude Desktop wrote its config and the documented one is absent.
				const root = join(home, "store-desktop");
				const storeConfig = join(
					root,
					"Local",
					"Packages",
					"Claude_0test0publisher",
					"LocalCache",
					"Roaming",
					"Claude",
					"claude_desktop_config.json"
				);
				const settings = { preferences: { sidebarMode: "chat" } };
				yield* fs.makeDirectory(dirname(storeConfig), { recursive: true });
				yield* writeJson(storeConfig, settings);
				yield* writeJson(join(root, ".claude.json"), { numStartups: 1 });
				const system = platformWith({
					...environment,
					APPDATA: join(root, "Roaming"),
					HOME: root,
					LOCALAPPDATA: join(root, "Local"),
					USERPROFILE: root,
				});
				const { system: onTerminal } = fakeTerminal(system, ["return"]);
				yield* withStdinTerminal(true)(cliOn(onTerminal)("install"));
				expect(yield* readJson(storeConfig)).toEqual({
					...settings,
					mcpServers: {
						mx: {
							args: ["mcp"],
							command: join(root, "Local", "Programs", "mx", "mx.exe"),
						},
					},
				});
				expect(yield* fs.exists(join(root, "Roaming", "Claude"))).toBe(false);
				yield* cliOn(system)("uninstall", "--yes");
				expect(yield* readJson(storeConfig)).toEqual({
					...settings,
					mcpServers: {},
				});
			})
		));

	test(
		"on macOS, mx install loads the LaunchAgent with launchctl bootstrap once it unloads the one loaded before, mx login restarts it with kickstart, and mx uninstall unloads it and deletes it with the log folder",
		() =>
			onMac(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const logs = join(library, "Logs", "mx");
					const bin = join(home, ".local", "bin", "mx");
					const before = processes.commands.length;
					yield* cli("install", "--agent", "codex");
					yield* cli("install", "--agent", "codex");
					const plist = yield* fs.readFileString(agentFile);
					expect(plist).toContain(`<string>${bin}</string>`);
					expect(plist).toContain(`<string>${join(logs, "sync.log")}</string>`);
					expect(yield* fs.exists(logs)).toBe(true);
					yield* cliOn(unconfigured)("login");
					yield* cli("uninstall", "--yes");
					const bootout = `launchctl bootout ${agentTarget}`;
					const print = `launchctl print ${agentTarget}`;
					const kickstart = `launchctl kickstart -k ${agentTarget}`;
					const bootstrap = `launchctl bootstrap ${agentDomain} ${agentFile}`;
					expect(
						Arr.map(processes.commands.slice(before), (command) =>
							Arr.join(command, " ")
						)
					).toEqual([
						bootout,
						print,
						bootstrap,
						bootout,
						print,
						bootstrap,
						kickstart,
						bootout,
					]);
					for (const path of [
						agentFile,
						logs,
						bin,
						join(support, "config.json"),
						join(support, "data"),
					]) {
						expect(yield* fs.exists(path)).toBe(false);
					}
				})
			),
		{
			because:
				"on macOS the install, login and uninstall tests above run these steps",
			systems: ["linux", "win32"],
		}
	);
});
