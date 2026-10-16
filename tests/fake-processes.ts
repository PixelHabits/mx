import { Array as Arr, Deferred, Effect, Layer, Sink, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { readUserPath, writeUserPath } from "../src/windows.ts";
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

/**
 * Every program mx starts, recorded and faked. `cloudflared tunnel` opens a quick tunnel on the fake internet, named
 * `tunnel-<n>.trycloudflare.com`, that runs until the scope that started it closes or `exit` ends it. The PowerShell
 * that reads the user PATH on Windows prints `userPath` as it does, and the one that writes it sets `userPath`. Any
 * other program exits 0 at once.
 */
export class FakeProcesses {
	readonly commands: (readonly string[])[] = [];
	/** The `Path` value under `HKCU\Environment`. */
	userPath = "";
	/** Runs as each program starts, for a test that checks what holds at that moment. */
	onSpawn: (() => void) | undefined;
	private opened = 0;
	private readonly running = new Map<
		string,
		Deferred.Deferred<ChildProcessSpawner.ExitCode>
	>();
	private readonly tunnels: FakeTunnels;

	constructor(tunnels: FakeTunnels) {
		this.tunnels = tunnels;
	}

	readonly layer = Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make((command) =>
			Effect.suspend(() => this.spawn(command))
		)
	);

	/** Ends the quick tunnel at `host` as if cloudflared exited with code 1. */
	exit(host: string) {
		const exit = this.running.get(host);
		return exit === undefined
			? Effect.die(`No tunnel runs at ${host}.`)
			: Effect.asVoid(Deferred.succeed(exit, ExitCode(1)));
	}

	private spawn(command: ChildProcess.Command) {
		if (command._tag !== "StandardCommand") {
			return Effect.die("mx pipes no commands.");
		}
		this.commands.push([command.command, ...command.args]);
		this.onSpawn?.();
		if (commandLine(command) === pathWrite) {
			this.userPath = command.options.env?.MX_PATH ?? "";
		}
		const stdout =
			commandLine(command) === pathRead
				? Stream.succeed(
						new Uint8Array(
							Buffer.from(
								Buffer.from(this.userPath, "utf16le").toString("base64")
							)
						)
					)
				: Stream.empty;
		return Effect.flatMap(
			Deferred.make<ChildProcessSpawner.ExitCode>(),
			(exit) => {
				if (command.args[0] !== "tunnel") {
					return Effect.as(
						Deferred.succeed(exit, ExitCode(0)),
						handle(this.commands.length, exit, stdout)
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
