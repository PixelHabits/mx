import { BunServices } from "@effect/platform-bun";
import {
	Array as Arr,
	Deferred,
	Effect,
	Layer,
	PlatformError,
	Sink,
	Stream,
} from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { queryWorker } from "../src/query.ts";
import { readUserPath, stopSync, writeUserPath } from "../src/windows.ts";
import type { FakeTunnels } from "./fake-push.ts";

const { ExitCode, makeHandle, ProcessId } = ChildProcessSpawner;

const handle = (
	pid: number,
	exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>,
	stdout: Stream.Stream<Uint8Array> = Stream.empty
) =>
	makeHandle({
		all: stdout,
		exitCode: Deferred.await(exit),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.map(Deferred.isDone(exit), (done) => !done),
		kill: () => Effect.asVoid(Deferred.succeed(exit, ExitCode(143))),
		pid: ProcessId(pid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout,
		unref: Effect.succeed(Effect.void),
	});

const flagValue = (args: readonly string[], flag: string) =>
	args[args.indexOf(flag) + 1] ?? "";

const commandLine = (command: ChildProcess.StandardCommand) =>
	Arr.join([command.command, ...command.args], " ");

/** The PowerShell that prints the user PATH, and the one that sets it from its environment. */
const pathRead = commandLine(readUserPath);
const pathWrite = commandLine(writeUserPath(""));

/** The PowerShell that stops the background `mx sync`; the process id it spares travels in its environment. */
const syncStop = commandLine(stopSync(0));

/** Whether `command` starts the background `mx sync`, as mxw.exe. */
const startsBackgroundSync = (command: ChildProcess.StandardCommand) =>
	command.command.endsWith("mxw.exe") && command.args[0] === "sync";

/** A LaunchAgent's label: its plist's name without `.plist`. */
const plistLabel = /([^/\\]+)\.plist$/u;

/**
 * Every program mx starts, recorded and faked. `cloudflared tunnel` opens a quick tunnel on the fake internet, named
 * `tunnel-<n>.trycloudflare.com`, that runs until the scope that started it closes or `exit` ends it. The PowerShell
 * that reads the user PATH on Windows prints `userPath` as it does, and the one that writes it sets `userPath`. mxw.exe
 * starts a background `mx sync` that runs on, and the PowerShell that stops mx sync ends each but the `unstoppable`
 * ones, prints the process id of each one left, and exits 1 when any is left. `launchctl` loads and unloads
 * LaunchAgents and fails as it does on macOS. A program in `missing` fails to start, as one the machine lacks does, one
 * in `failing` exits 1, and one in `hanging` runs until the scope that started it closes, which kills it as Effect's
 * spawner does. Any other program exits 0 at once. What mx writes to a program's stdin goes to `inputs`.
 */
export class FakeProcesses {
	readonly commands: (readonly string[])[] = [];
	/** What mx wrote to the stdin of each program it gave input, by the program's index in `commands`. */
	readonly inputs = new Map<number, string>();
	/** The programs this machine lacks. */
	readonly missing = new Set<string>();
	/** The programs that exit 1. */
	readonly failing = new Set<string>();
	/** The programs that never exit on their own. */
	readonly hanging = new Set<string>();
	/** The programs killed, by their index in `commands`. */
	readonly killed = new Set<number>();
	/** The `Path` value under `HKCU\Environment`. */
	userPath = "";
	/** Runs as each program starts, for a test that checks what holds at that moment. */
	onSpawn: (() => void) | undefined;
	/**
	 * How many times `launchctl print` still finds an agent that `launchctl bootout` unloaded: launchd removes it only
	 * once its `mx sync` has exited.
	 */
	removalLag = 0;
	/** The service targets of the LaunchAgents loaded, such as `gui/501/io.github.pixelhabits.mx.sync`. */
	readonly loaded = new Set<string>();
	/** The process ids of the background `mx sync` processes that run on Windows. */
	readonly syncs = new Set<number>();
	/** The background `mx sync` processes that outlive the PowerShell that stops mx sync. */
	readonly unstoppable = new Set<number>();
	private opened = 0;
	/** The agents unloaded that launchd has not removed yet, with how many more `launchctl print` calls find each. */
	private readonly removing = new Map<string, number>();
	private readonly running = new Map<
		string,
		Deferred.Deferred<ChildProcessSpawner.ExitCode>
	>();
	private readonly tunnels: FakeTunnels;

	constructor(tunnels: FakeTunnels) {
		this.tunnels = tunnels;
	}

	/** The programs mx starts, faked, except mx's own query worker, which runs for real and goes unrecorded. */
	readonly layer = Layer.effect(
		ChildProcessSpawner.ChildProcessSpawner,
		Effect.map(ChildProcessSpawner.ChildProcessSpawner, (system) =>
			ChildProcessSpawner.make((command) =>
				command._tag === "StandardCommand" &&
				command.args.at(-1) === queryWorker
					? system.spawn(command)
					: Effect.suspend(() => this.spawn(command))
			)
		)
	).pipe(Layer.provide(BunServices.layer));

	/** Ends the quick tunnel at `host` as if cloudflared exited with code 1. */
	exit(host: string) {
		const exit = this.running.get(host);
		return exit === undefined
			? Effect.die(`No tunnel runs at ${host}.`)
			: Effect.asVoid(Deferred.succeed(exit, ExitCode(1)));
	}

	/**
	 * How a program that runs to its end exits. launchctl fails as it does on macOS: `bootstrap` of a loaded agent with
	 * 5 and of one launchd has not removed yet with 37, `bootout` and `kickstart` of one that is not loaded with 3 and
	 * 113, and `print` of one launchd does not hold with 113.
	 */
	private exitCode(command: ChildProcess.StandardCommand) {
		if (commandLine(command) === syncStop) {
			return this.syncs.size === 0 ? 0 : 1;
		}
		if (command.command !== "launchctl") {
			return 0;
		}
		const [subcommand, target = "", plist = ""] = command.args;
		switch (subcommand) {
			case "bootstrap": {
				const service = `${target}/${plistLabel.exec(plist)?.[1] ?? ""}`;
				if (this.loaded.has(service)) {
					return 5;
				}
				if (this.removing.has(service)) {
					return 37;
				}
				this.loaded.add(service);
				return 0;
			}
			case "bootout":
				if (!this.loaded.delete(target)) {
					return 3;
				}
				if (this.removalLag > 0) {
					this.removing.set(target, this.removalLag);
				}
				return 0;
			case "kickstart":
				return this.loaded.has(command.args.at(-1) ?? "") ? 0 : 113;
			case "print":
				return this.loaded.has(target) || this.stillHeld(target) ? 0 : 113;
			default:
				return 0;
		}
	}

	/** Whether launchd still holds `target`, unloaded but not removed; it removes it once `print` found it `removalLag` times. */
	private stillHeld(target: string) {
		const left = this.removing.get(target);
		if (left === undefined) {
			return false;
		}
		if (left > 1) {
			this.removing.set(target, left - 1);
		} else {
			this.removing.delete(target);
		}
		return true;
	}

	/** What the program run as `line` prints. */
	private printed(line: string) {
		const text = (output: string) =>
			Stream.succeed(new Uint8Array(Buffer.from(output)));
		if (line === pathRead) {
			return text(Buffer.from(this.userPath, "utf16le").toString("base64"));
		}
		if (line === syncStop) {
			return text(
				Arr.join(
					Arr.map([...this.syncs], (pid) => `${pid}\r\n`),
					""
				)
			);
		}
		return Stream.empty;
	}

	private spawn(command: ChildProcess.Command) {
		if (command._tag !== "StandardCommand") {
			return Effect.die("mx pipes no commands.");
		}
		this.commands.push([command.command, ...command.args]);
		this.onSpawn?.();
		if (this.missing.has(command.command)) {
			return Effect.fail(
				PlatformError.systemError({
					_tag: "NotFound",
					method: "spawn",
					module: "ChildProcess",
					pathOrDescriptor: command.command,
				})
			);
		}
		const index = this.commands.length - 1;
		const { stdin } = command.options;
		const input = Stream.isStream(stdin)
			? Effect.map(Stream.mkString(Stream.decodeText(stdin)), (text) => {
					this.inputs.set(index, text);
				})
			: Effect.void;
		const line = commandLine(command);
		if (line === pathWrite) {
			this.userPath = command.options.env?.MX_PATH ?? "";
		}
		if (line === syncStop) {
			for (const pid of this.syncs) {
				if (!this.unstoppable.has(pid)) {
					this.syncs.delete(pid);
				}
			}
		}
		if (startsBackgroundSync(command)) {
			this.syncs.add(this.commands.length);
		}
		const stdout = this.printed(line);
		return Effect.flatMap(
			Deferred.make<ChildProcessSpawner.ExitCode>(),
			(exit) => {
				if (this.hanging.has(command.command)) {
					return Effect.andThen(
						input,
						Effect.as(
							Effect.addFinalizer(() =>
								Effect.andThen(
									Deferred.succeed(exit, ExitCode(143)),
									Effect.sync(() => {
										this.killed.add(index);
									})
								)
							),
							handle(this.commands.length, exit)
						)
					);
				}
				if (command.args[0] !== "tunnel") {
					return Effect.andThen(
						input,
						Effect.as(
							Deferred.succeed(
								exit,
								ExitCode(
									this.failing.has(command.command) ? 1 : this.exitCode(command)
								)
							),
							handle(this.commands.length, exit, stdout)
						)
					);
				}
				this.opened += 1;
				const host = `tunnel-${this.opened}.trycloudflare.com`;
				const metrics = flagValue(command.args, "--metrics");
				this.tunnels.hosts.set(
					host,
					Number(new URL(flagValue(command.args, "--url")).port)
				);
				this.tunnels.metrics.set(metrics, host);
				this.running.set(host, exit);
				return Effect.as(
					Effect.addFinalizer(() =>
						Effect.sync(() => {
							this.tunnels.hosts.delete(host);
							this.tunnels.metrics.delete(metrics);
						})
					),
					handle(this.commands.length, exit)
				);
			}
		);
	}
}
