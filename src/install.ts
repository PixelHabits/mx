import {
	Array as Arr,
	Console,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type Agent, type AgentId, agents, type ConfigFile } from "./agents.ts";
import { Auth, signIn } from "./auth/auth.ts";
import type { SignInConfig } from "./auth/config.ts";
import { Credentials } from "./auth/credentials.ts";
import {
	InstallFailed,
	type MicrosoftUnavailable,
	type SignInFailed,
} from "./errors.ts";
import type { GraphError } from "./graph/graph.ts";
import { Paths } from "./paths.ts";
import {
	deleteAfterExit,
	readUserPath,
	stopSync,
	userPathFrom,
	writeUserPath,
} from "./windows.ts";

/** The systemd user unit that runs `mx sync` from login to logout. */
const unitName = "mx-sync.service";

/** Its text, for `mx sync` from `bin`; the Arch package ships it for `/usr/bin/mx`. */
export const unit = (bin: string) => `[Unit]
Description=mx: keep the local copy of the mailbox in step with Microsoft Graph

[Service]
Type=exec
ExecStart="${bin}" sync
# A refused sign-in stops mx sync with "Run mx login."; it starts again by itself after the next login.
Restart=on-failure
RestartSec=5min

[Install]
WantedBy=default.target
`;

/** The per-user Run key: Windows runs each value's command at sign-in, and writing it needs no admin rights. */
const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * The copy of mx.exe that runs `mx sync` in the background. Windows opens a console window for a console exe it starts
 * at sign-in; this copy is marked a GUI program, so it starts with none, while mx.exe stays a console program for
 * `mx login` and `mx mcp`.
 */
const backgroundName = "mxw.exe";

/** The PE optional header starts after the 4-byte signature and the 20-byte COFF header; Subsystem is at offset 68. */
const subsystemOffset = 4 + 20 + 68;
const windowsGuiSubsystem = 2;

/** The exe with its Subsystem set to WINDOWS_GUI, the one field `bun build --windows-hide-console` changes. */
const windowsGui = (exe: Uint8Array) => {
	const copy = exe.slice();
	const view = new DataView(copy.buffer);
	view.setUint16(
		view.getUint32(0x3c, true) + subsystemOffset,
		windowsGuiSubsystem,
		true
	);
	return copy;
};

const exeSuffix = /\.exe$/u;

/** Where Windows moves a running exe aside, as mx.old.exe. */
const oldName = (exe: string) => exe.replace(exeSuffix, ".old.exe");

const trailingBackslashes = /\\+$/u;

/** Names agents as a sentence does: `Claude Code and Codex`. */
const listed = new Intl.ListFormat("en", { type: "conjunction" });

/** One thing `mx uninstall` removes: `what` names it as the prompt lists it, and `remove` removes it and says so. */
export interface Removal {
	readonly remove: Effect.Effect<void, InstallFailed>;
	readonly what: string;
}

/**
 * Installs mx for the signed-in user: the binary, the background `mx sync`, and `mx mcp` in the config of each agent
 * chosen. Each step writes the state it wants, so running it again reinstalls without duplicating anything.
 */
export class Installer extends Context.Service<
	Installer,
	{
		/**
		 * Sets up `agents`, signs in with `login` when there is no sign-in saved for it, runs `firstSync` and then starts
		 * the background `mx sync`.
		 */
		readonly install: (options: {
			readonly agents: readonly AgentId[];
			/** The sync to run in the foreground once signed in, before mx sync starts in the background. */
			readonly firstSync: Effect.Effect<void, GraphError>;
			readonly login: SignInConfig;
		}) => Effect.Effect<
			void,
			InstallFailed | SignInFailed | MicrosoftUnavailable | GraphError
		>;
		/** What `mx uninstall` removes on this machine, in the order it removes them. */
		readonly removals: Effect.Effect<readonly Removal[], InstallFailed>;
		/** Puts `bytes` in place as the installed binary, also while it runs. */
		readonly replaceBinary: (
			bytes: Uint8Array
		) => Effect.Effect<void, InstallFailed>;
		/** Starts the background `mx sync` from the installed binary, stopping the one that runs. */
		readonly restartSync: Effect.Effect<void, InstallFailed>;
		/**
		 * Restarts the background `mx sync` when `mx install` registered it to start at sign-in, as after `mx login`, so
		 * it runs with the new sign-in; does nothing elsewhere, as for mx run from source.
		 */
		readonly resumeSync: Effect.Effect<void, InstallFailed>;
		/**
		 * Deletes the binaries an update on Windows moved aside. One still runs until its process ends, as an MCP server
		 * that Claude started; the next start tries again.
		 */
		readonly removeOldBinaries: Effect.Effect<void>;
	}
>()("mx/install/Installer") {
	static readonly layerNoDeps = Layer.effect(
		Installer,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const credentials = yield* Credentials;
			const auth = yield* Auth;
			const { bin, cache, config, configFile, data, packaged, state } =
				yield* Paths;
			const offered = yield* agents;
			const windows = process.platform === "win32";
			const folder = path.dirname(bin);
			const background = path.join(folder, backgroundName);
			const unitFile = path.join(config, "systemd", "user", unitName);
			const failed = (step: string) => (error: { readonly message: string }) =>
				InstallFailed.make({ message: `${step}: ${error.message}` });

			/**
			 * Runs `command` to its end, called `name` when it fails; `allowFailure` is for a removal that has nothing to
			 * remove.
			 */
			const execute = (
				name: string,
				command: ChildProcess.Command,
				options: { readonly allowFailure?: boolean } = {}
			) =>
				spawner.exitCode(command).pipe(
					Effect.mapError(failed(name)),
					Effect.flatMap((code) =>
						code === 0 || options.allowFailure === true
							? Effect.void
							: InstallFailed.make({
									message: `${name} exited with code ${code}.`,
								})
					)
				);

			/** Runs a program to its end; `allowFailure` is for a removal that has nothing to remove. */
			const run = (
				command: string,
				args: readonly string[],
				options: { readonly allowFailure?: boolean } = {}
			) =>
				execute(
					`${command} ${Arr.join(args, " ")}`,
					ChildProcess.make(command, args, {
						stderr: "inherit",
						stdin: "ignore",
						stdout: "ignore",
					}),
					options
				);

			/** Whether a program exits 0, with its output hidden; a machine without the program answers no. */
			const succeeds = (command: string, args: readonly string[]) =>
				spawner
					.exitCode(
						ChildProcess.make(command, args, {
							stderr: "ignore",
							stdin: "ignore",
							stdout: "ignore",
						})
					)
					.pipe(
						Effect.map((code) => code === 0),
						Effect.catchIf(
							(error) => error.reason._tag === "NotFound",
							() => Effect.succeed(false)
						),
						Effect.mapError(failed(`${command} ${Arr.join(args, " ")}`))
					);

			/** Starts `command`, named `what`, on its own, so it outlives this process. */
			const startDetached = (what: string, command: ChildProcess.Command) =>
				Effect.scoped(
					Effect.flatMap(spawner.spawn(command), (started) => started.unref)
				).pipe(Effect.asVoid, Effect.mapError(failed(what)));

			/**
			 * Writes the whole binary next to `target` and renames it into place, so `target` never holds part of one. Windows
			 * lets a running exe be renamed but not replaced, so there the old one moves aside first, and back when the new one
			 * cannot take its place; the next start deletes it.
			 */
			const put = Effect.fnUntraced(function* (
				target: string,
				bytes: Uint8Array
			) {
				const staged = yield* fs.makeTempFileScoped({ directory: folder });
				yield* fs.writeFile(staged, bytes);
				if (!windows) {
					yield* fs.chmod(staged, 0o755);
					yield* fs.rename(staged, target);
					return;
				}
				const old = oldName(target);
				yield* fs.remove(old, { force: true });
				if (yield* fs.exists(target)) {
					yield* fs.rename(target, old);
				}
				yield* fs
					.rename(staged, target)
					.pipe(Effect.tapError(() => Effect.ignore(fs.rename(old, target))));
			}, Effect.scoped);

			const replaceBinary = Effect.fn("Installer.replaceBinary")(
				function* (bytes: Uint8Array) {
					yield* fs.makeDirectory(folder, { recursive: true });
					yield* put(bin, bytes);
					if (windows) {
						yield* put(background, windowsGui(bytes));
					}
				},
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(failed(`Could not write ${bin}`)(error))
				)
			);

			/** Stops every other background `mx sync` on Windows, with the cloudflared each started, and waits for them. */
			const stopRunningSync = execute(
				"The PowerShell that stops mx sync",
				stopSync(process.pid)
			);

			const restartSync = windows
				? Effect.andThen(
						stopRunningSync,
						startDetached(
							`Could not start ${background}`,
							ChildProcess.make(background, ["sync"], {
								detached: true,
								stderr: "ignore",
								stdin: "ignore",
								stdout: "ignore",
							})
						)
					)
				: run("systemctl", ["--user", "restart", "--no-block", unitName]);

			const syncRegistered = windows
				? succeeds("reg", ["query", runKey, "/v", "mx"])
				: succeeds("systemctl", ["--user", "is-enabled", "--quiet", unitName]);

			const resumeSync = Effect.gen(function* () {
				if (!(yield* syncRegistered)) {
					return;
				}
				yield* restartSync;
				yield* Console.log("Restarted mx sync.");
			});

			const registerSync = windows
				? run("reg", [
						"add",
						runKey,
						"/v",
						"mx",
						"/t",
						"REG_SZ",
						"/d",
						`"${background}" sync`,
						"/f",
					])
				: Effect.gen(function* () {
						// The Arch package ships the unit in /usr/lib/systemd/user.
						if (!packaged) {
							yield* fs
								.makeDirectory(path.dirname(unitFile), { recursive: true })
								.pipe(Effect.mapError(failed(`Could not create ${unitFile}`)));
							yield* fs
								.writeFileString(unitFile, unit(bin))
								.pipe(Effect.mapError(failed(`Could not write ${unitFile}`)));
						}
						yield* run("systemctl", ["--user", "daemon-reload"]);
						yield* run("systemctl", ["--user", "enable", unitName]);
					});

			const unregisterSync = windows
				? Effect.andThen(
						stopRunningSync,
						run("reg", ["delete", runKey, "/v", "mx", "/f"], {
							allowFailure: true,
						})
					)
				: Effect.gen(function* () {
						yield* run("systemctl", ["--user", "disable", "--now", unitName], {
							allowFailure: true,
						});
						if (!packaged) {
							yield* fs
								.remove(unitFile, { force: true })
								.pipe(Effect.mapError(failed(`Could not delete ${unitFile}`)));
						}
						yield* run("systemctl", ["--user", "daemon-reload"]);
					});

			/** The user's own PATH on Windows, as stored. A PATH mx could not read fails, so mx never writes over one. */
			const userPath = Effect.scoped(
				Effect.gen(function* () {
					const reading = yield* spawner.spawn(readUserPath);
					const [output, code] = yield* Effect.all(
						[
							Stream.mkString(Stream.decodeText(reading.stdout)),
							reading.exitCode,
						],
						{ concurrency: "unbounded" }
					);
					if (code !== 0) {
						return yield* InstallFailed.make({
							message: `Could not read your PATH: PowerShell exited with code ${code}.`,
						});
					}
					return userPathFrom(output);
				})
			).pipe(
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(failed("Could not read your PATH")(error))
				)
			);

			/** Whether a PATH entry names the program folder; Windows compares paths without case. */
			const isProgramFolder = (entry: string) =>
				entry.replace(trailingBackslashes, "").toLowerCase() ===
				folder.toLowerCase();

			/** Puts the program folder on the user's PATH after every entry it holds, unless it is there. */
			const addToPath = Effect.gen(function* () {
				const current = yield* userPath;
				if (Arr.some(current.split(";"), isProgramFolder)) {
					return;
				}
				yield* execute(
					`The PowerShell that adds ${folder} to your PATH`,
					writeUserPath(
						current === "" || current.endsWith(";")
							? `${current}${folder}`
							: `${current};${folder}`
					)
				);
				yield* Console.log(
					`Added ${folder} to your PATH. Open a new terminal to run mx.`
				);
			});

			/**
			 * Writes `text` over the config file by renaming a whole file onto it, so the agent never reads half of one. A
			 * config that is a symlink, as into a dotfiles repository, stays one, and the file keeps its mode. A config that
			 * does not exist yet is created.
			 */
			const writeConfig = Effect.fnUntraced(function* (
				file: string,
				text: string
			) {
				const exists = yield* fs.exists(file);
				const target = exists ? yield* fs.realPath(file) : file;
				yield* fs.makeDirectory(path.dirname(target), { recursive: true });
				const staged = yield* fs.makeTempFileScoped({
					directory: path.dirname(target),
				});
				yield* fs.writeFileString(staged, text);
				if (exists) {
					yield* fs.chmod(staged, (yield* fs.stat(target)).mode % 0o1000);
				}
				yield* fs.rename(staged, target);
			}, Effect.scoped);

			/** The text mx edits: the file's, or the one mx starts from when there is none; none when the agent must write it. */
			const current = (file: ConfigFile) =>
				fs.exists(file.path).pipe(
					Effect.flatMap((exists) =>
						exists
							? Effect.asSome(fs.readFileString(file.path))
							: Effect.succeed(file.initial)
					),
					Effect.mapError(failed(`Could not read ${file.path}`))
				);

			/** The file's text with mx set up; fails when the agent has not written the file yet. */
			const setUp = (agent: Agent, file: ConfigFile) =>
				Effect.flatMap(
					current(file),
					Option.match({
						onNone: () =>
							InstallFailed.make({
								message: `${file.path} does not exist. ${agent.createConfig}`,
							}),
						onSome: file.setUp,
					})
				);

			const takeOut = (file: ConfigFile) =>
				Effect.flatMap(
					current(file),
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: file.takeOut,
					})
				);

			/**
			 * Runs `edit`, which reads the file, and writes its answer right away, so what another program saved to the file
			 * earlier stays. Prints `done` when it wrote.
			 */
			const change = (
				file: ConfigFile,
				edit: Effect.Effect<Option.Option<string>, InstallFailed>,
				done: string
			) =>
				Effect.flatMap(
					edit,
					Option.match({
						onNone: () => Effect.void,
						onSome: (text) =>
							writeConfig(file.path, text).pipe(
								Effect.mapError(failed(`Could not write ${file.path}`)),
								Effect.andThen(Console.log(done))
							),
					})
				);

			/** Whether a sign-in is saved. */
			const signedIn = credentials.read.pipe(
				Effect.as(true),
				Effect.catchTag("LoginRequired", () => Effect.succeed(false))
			);

			const install = Effect.fn("Installer.install")(
				function* ({
					agents: chosen,
					firstSync,
					login,
				}: {
					readonly agents: readonly AgentId[];
					readonly firstSync: Effect.Effect<void, GraphError>;
					readonly login: SignInConfig;
				}) {
					// Every config is read and edited before anything changes, so a missing or unreadable one changes nothing.
					const set = yield* Effect.forEach(Arr.dedupe(chosen), (id) =>
						Effect.gen(function* () {
							const agent = Arr.findFirst(offered, (each) => each.id === id);
							if (Option.isNone(agent)) {
								return yield* InstallFailed.make({
									message:
										"mx sets up Claude Desktop on Windows and macOS only.",
								});
							}
							yield* Effect.forEach(
								agent.value.files,
								(file) => setUp(agent.value, file),
								{ discard: true }
							);
							return agent.value;
						})
					);
					if (path.resolve(process.execPath) !== path.resolve(bin)) {
						const bytes = yield* fs
							.readFile(process.execPath)
							.pipe(
								Effect.mapError(failed(`Could not read ${process.execPath}`))
							);
						yield* replaceBinary(bytes);
						yield* Console.log(`Installed ${bin}.`);
					}
					if (windows) {
						yield* addToPath;
					}
					yield* registerSync;
					yield* Console.log("Registered mx sync to start at sign-in.");
					// Each config is read again as it is written, so what an agent saved to it in the meantime stays.
					for (const agent of set) {
						for (const file of agent.files) {
							yield* change(
								file,
								setUp(agent, file),
								`Registered mx with ${agent.app} in ${file.path}.`
							);
						}
					}
					yield* credentials.use(login);
					if (!(yield* signedIn)) {
						yield* signIn(auth, login);
					}
					yield* firstSync;
					yield* restartSync;
					yield* Console.log("Started mx sync.");
					yield* Console.log(
						`Quit and reopen ${listed.format(Arr.map(set, ({ app }) => app))} now. An agent left open can write its old settings back and drop mx.`
					);
				},
				Effect.catchTag("CredentialFailed", (error) =>
					Effect.fail(failed("Could not read the saved sign-in")(error))
				)
			);

			/** A file or folder mx removes when it exists, named `what`. */
			const removeFile = (what: string, file: string) =>
				Effect.map(fs.exists(file), (exists) =>
					exists
						? [
								{
									remove: fs
										.remove(file, { force: true, recursive: true })
										.pipe(
											Effect.mapError(failed(`Could not delete ${file}`)),
											Effect.andThen(Console.log(`Removed ${what}: ${file}.`))
										),
									what: `${what}: ${file}`,
								},
							]
						: []
				);

			/** Whether `file` is the exe this process runs; Windows compares paths without case. */
			const isThisExe = (file: string) =>
				file.toLowerCase() === path.resolve(process.execPath).toLowerCase();

			/**
			 * The program folder on Windows, with mx.exe, mxw.exe and the copies an update moved aside. Windows deletes no exe
			 * that runs: the one this process runs goes once it exits, through a PowerShell that waits for it, and one
			 * another mx runs, as the mx mcp an agent started, stays until the user quits that agent.
			 */
			const removeWindowsProgram = Effect.gen(function* () {
				if (!(yield* fs.exists(folder))) {
					return [];
				}
				const files = yield* Effect.filter(
					[bin, background, oldName(bin), oldName(background)],
					(file) => fs.exists(file)
				);
				const remove = Effect.gen(function* () {
					const inUse = yield* Effect.filter(
						Arr.filter(files, (file) => !isThisExe(file)),
						(file) =>
							fs.remove(file, { force: true }).pipe(
								Effect.as(false),
								Effect.catchTag("PlatformError", () => Effect.succeed(true))
							)
					);
					for (const file of inUse) {
						yield* Console.log(
							`Could not delete ${file} while another mx runs it, such as the mx mcp that Claude or Codex started. Delete ${folder} after you quit them.`
						);
					}
					if (Arr.some(files, isThisExe)) {
						yield* startDetached(
							`Could not start the PowerShell that deletes ${folder}`,
							deleteAfterExit({ folder, pid: process.pid })
						);
						yield* Console.log(`mx uninstall deletes ${folder} once it exits.`);
						return;
					}
					if (Arr.isArrayEmpty(inUse)) {
						yield* fs
							.remove(folder, { recursive: true })
							.pipe(Effect.mapError(failed(`Could not delete ${folder}`)));
						yield* Console.log(`Removed the installed program: ${folder}.`);
					}
				});
				return [
					{
						remove,
						what: `the installed program: ${Arr.isArrayNonEmpty(files) ? Arr.join(files, ", ") : folder}`,
					},
				];
			});

			/** The program folder on the user's PATH, which `mx install` puts there on Windows. */
			const removeFromPath: Removal = {
				remove: Effect.gen(function* () {
					const entries = (yield* userPath).split(";");
					if (!Arr.some(entries, isProgramFolder)) {
						return;
					}
					yield* execute(
						`The PowerShell that takes ${folder} out of your PATH`,
						writeUserPath(
							Arr.join(
								Arr.filter(entries, (entry) => !isProgramFolder(entry)),
								";"
							)
						)
					);
					yield* Console.log(`Removed ${folder} from your PATH.`);
				}),
				what: `${folder} in your PATH`,
			};

			/** What starts `mx sync` at sign-in, as `mx uninstall` removes it; stopping sync comes with it. */
			const syncRegistration = Effect.gen(function* () {
				if (packaged) {
					return [
						{
							remove: Effect.andThen(
								unregisterSync,
								Console.log(
									`Stopped mx sync and disabled ${unitName}. pacman -R mx removes ${bin} and the unit.`
								)
							),
							what: `the start of mx sync at sign-in: systemctl --user disable ${unitName}`,
						},
					];
				}
				if (windows) {
					return [
						{
							remove: Effect.andThen(
								unregisterSync,
								Console.log("Stopped mx sync and removed its registration.")
							),
							what: `the mx value under ${runKey}, which starts mx sync at sign-in`,
						},
					];
				}
				return Arr.map(
					yield* removeFile("the sync unit", unitFile),
					(removal): Removal => ({
						remove: Effect.andThen(
							unregisterSync,
							Console.log(`Stopped mx sync and removed ${unitFile}.`)
						),
						what: removal.what,
					})
				);
			});

			/** What mx install wrote of the program; none when the package owns the binary. */
			const programRemovals = Effect.gen(function* () {
				if (packaged) {
					return [];
				}
				if (windows) {
					return [removeFromPath, ...(yield* removeWindowsProgram)];
				}
				return yield* removeFile("the installed binary", bin);
			});

			/**
			 * Each running `mx mcp` holds the mail store open, and Windows deletes no open file; there the store stays until the
			 * user quits the agents that run mx.
			 */
			const removeStore = Effect.map(fs.exists(data), (exists) =>
				exists
					? [
							{
								remove: fs.remove(data, { force: true, recursive: true }).pipe(
									Effect.andThen(
										Console.log(`Removed the mail store: ${data}.`)
									),
									Effect.catchIf(
										(error) => error.reason._tag === "Busy",
										() =>
											Console.log(
												`Could not delete ${data} while mx mcp has it open. Delete it after you quit Claude and Codex.`
											)
									),
									Effect.mapError(failed(`Could not delete ${data}`))
								),
								what: `the mail store: ${data}`,
							},
						]
					: []
			);

			/**
			 * Sync stops first, so nothing writes to the store as it goes. On Linux it deletes its Graph subscriptions as it
			 * stops, while its sign-in is still saved; on Windows nothing can ask it to stop, so they stay until they expire,
			 * on a tunnel that is gone.
			 */
			const removals = Effect.gen(function* () {
				const registration = yield* syncRegistration;
				const signInRemoval: readonly Removal[] = (yield* signedIn)
					? [
							{
								remove: credentials.remove.pipe(
									Effect.mapError(failed("Could not delete the saved sign-in")),
									Effect.andThen(Console.log("Removed the saved sign-in."))
								),
								what: "the saved sign-in",
							},
						]
					: [];
				const agentRemovals = Arr.getSomes(
					yield* Effect.forEach(
						Arr.flatMap(offered, (agent) => agent.files),
						(file) =>
							Effect.map(
								takeOut(file),
								Option.map(
									(): Removal => ({
										remove: change(
											file,
											takeOut(file),
											`Removed ${file.holds} from ${file.path}.`
										),
										what: `${file.holds} in ${file.path}`,
									})
								)
							)
					)
				);
				return Arr.flatten([
					registration,
					agentRemovals,
					yield* programRemovals,
					yield* removeFile("the client id and the tenant", configFile),
					yield* removeStore,
					signInRemoval,
					yield* removeFile("the attachment cache", cache),
					yield* removeFile("the state folder", state),
				]);
			}).pipe(
				Effect.catchTags({
					CredentialFailed: (error) =>
						Effect.fail(failed("Could not read the saved sign-in")(error)),
					PlatformError: (error) =>
						Effect.fail(failed("Could not look for mx's files")(error)),
				}),
				Effect.withSpan("Installer.removals")
			);

			const removeOldBinaries = windows
				? Effect.forEach(
						[bin, background],
						(file) => Effect.ignore(fs.remove(oldName(file), { force: true })),
						{ discard: true }
					)
				: Effect.void;

			return Installer.of({
				install,
				removals,
				removeOldBinaries,
				replaceBinary,
				restartSync,
				resumeSync,
			});
		})
	);

	static readonly layer = Installer.layerNoDeps.pipe(
		Layer.provide(Layer.mergeAll(Auth.layer, Credentials.layer))
	);
}
