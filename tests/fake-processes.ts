import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import type { FakeTunnels } from "./fake-push.ts";

const { ExitCode, makeHandle, ProcessId } = ChildProcessSpawner;

const handle = (
	pid: number,
	exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>
) =>
	makeHandle({
		all: Stream.empty,
		exitCode: Deferred.await(exit),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.map(Deferred.isDone(exit), (done) => !done),
		kill: () => Effect.asVoid(Deferred.succeed(exit, ExitCode(143))),
		pid: ProcessId(pid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout: Stream.empty,
		unref: Effect.succeed(Effect.void),
	});

const flagValue = (args: readonly string[], flag: string) =>
	args[args.indexOf(flag) + 1] ?? "";

/**
 * Every program mx starts, recorded and faked. `cloudflared tunnel` opens a quick tunnel on the fake internet, named
 * `tunnel-<n>.trycloudflare.com`, that runs until the scope that started it closes or `exit` ends it. Any other program
 * exits 0 at once.
 */
export class FakeProcesses {
	readonly commands: (readonly string[])[] = [];
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
		ChildProcessSpawner.make((command) => this.spawn(command))
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
		return Effect.flatMap(
			Deferred.make<ChildProcessSpawner.ExitCode>(),
			(exit) => {
				if (command.args[0] !== "tunnel") {
					return Effect.as(
						Deferred.succeed(exit, ExitCode(0)),
						handle(this.commands.length, exit)
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
