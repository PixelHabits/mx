import {
	Config,
	Context,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schedule,
	Schema,
	type Scope,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { PushUnavailable } from "../errors.ts";
import { policy } from "../http-policy.ts";
import { Paths } from "../paths.ts";

/** The cloudflared release mx downloads when neither `MX_CLOUDFLARED` nor PATH names one. */
const version = "2026.10.1";

/** Each pinned asset's sha256, computed from the official GitHub release. */
const releases: Partial<
	Record<string, { readonly sha256: string; readonly url: string }>
> = {
	"linux-x64": {
		sha256: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586",
		url: `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-amd64`,
	},
	"win32-x64": {
		sha256: "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6",
		url: `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`,
	},
};

/** The download is about 55 MB at most. */
const downloadDeadline = Duration.minutes(10);

/** How long cloudflared may take to name its quick tunnel's host, asked every 250 ms. */
const hostWait = Duration.seconds(30);
const hostPollSpacing = Duration.millis(250);

const QuickTunnel = Schema.Struct({ hostname: Schema.NonEmptyString });

const executableName =
	process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

/** A loopback port nothing listens on. */
const freePort = Effect.acquireUseRelease(
	Effect.sync(() =>
		Bun.serve({
			fetch: () => new Response(null),
			hostname: "127.0.0.1",
			port: 0,
		})
	),
	(probe) => Effect.succeed(probe.port),
	(probe) => Effect.promise(() => probe.stop(true))
);

/** A running quick tunnel: its public host, and an effect that fails when cloudflared exits. */
export interface Tunnel {
	readonly exited: Effect.Effect<never, PushUnavailable>;
	readonly host: string;
}

/**
 * Cloudflare quick tunnels through cloudflared. mx runs the binary `MX_CLOUDFLARED` names, else the one on PATH, else
 * the pinned release it downloads once into its data folder and checks against its sha256.
 */
export class Cloudflared extends Context.Service<
	Cloudflared,
	{
		/** Starts a quick tunnel to `http://127.0.0.1:<port>`; closing the scope stops cloudflared. */
		readonly open: (
			port: number
		) => Effect.Effect<Tunnel, PushUnavailable, Scope.Scope>;
	}
>()("mx/push/cloudflared") {
	static readonly layer = Layer.effect(
		Cloudflared,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const http = yield* HttpClient.HttpClient;
			const downloads = policy(http, { deadline: downloadDeadline });
			const { data } = yield* Paths;
			const { override, searchPath } = yield* Config.all({
				override: Config.option(Config.NonEmptyString("MX_CLOUDFLARED")),
				searchPath: Config.String("PATH").pipe(Config.withDefault("")),
			});
			const managed = path.join(data, "cloudflared", version, executableName);
			const unavailable = (message: string) =>
				PushUnavailable.make({ message });

			const download = Effect.gen(function* () {
				const release = releases[`${process.platform}-${process.arch}`];
				if (release === undefined) {
					return yield* unavailable(
						`No cloudflared release is pinned for ${process.platform}-${process.arch}; set MX_CLOUDFLARED.`
					);
				}
				const bytes = yield* downloads.get(release.url).pipe(
					Effect.flatMap(HttpClientResponse.filterStatusOk),
					Effect.flatMap((response) => response.arrayBuffer),
					Effect.mapError(() =>
						unavailable(`Could not download cloudflared from ${release.url}.`)
					)
				);
				const sha256 = new Bun.CryptoHasher("sha256")
					.update(bytes)
					.digest("hex");
				if (sha256 !== release.sha256) {
					return yield* unavailable(
						`The cloudflared download has sha256 ${sha256}, not the pinned ${release.sha256}.`
					);
				}
				yield* fs.makeDirectory(path.dirname(managed), { recursive: true });
				const staged = yield* fs.makeTempFileScoped({
					directory: path.dirname(managed),
				});
				yield* fs.writeFile(staged, new Uint8Array(bytes));
				yield* fs.chmod(staged, 0o755);
				yield* fs.rename(staged, managed);
				return managed;
			}).pipe(
				Effect.scoped,
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(
						unavailable(`Could not save cloudflared: ${error.message}`)
					)
				)
			);

			const executable = Effect.gen(function* () {
				if (Option.isSome(override)) {
					return (yield* fs.exists(override.value))
						? override.value
						: yield* unavailable(
								`MX_CLOUDFLARED names ${override.value}, which does not exist.`
							);
				}
				const onPath = Bun.which("cloudflared", { PATH: searchPath });
				if (onPath !== null) {
					return onPath;
				}
				return (yield* fs.exists(managed)) ? managed : yield* download;
			}).pipe(
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(unavailable(error.message))
				)
			);

			/** The quick tunnel's host, asked of cloudflared's metrics server until it names one. */
			const quickTunnelHost = (metrics: string) =>
				http.get(`http://${metrics}/quicktunnel`).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(QuickTunnel)),
					Effect.map(({ hostname }) => hostname),
					Effect.mapError(() =>
						unavailable("cloudflared's metrics server named no host.")
					),
					Effect.retry(Schedule.spaced(hostPollSpacing))
				);

			const open = Effect.fn("Cloudflared.open")(function* (port: number) {
				const command = yield* executable;
				const metrics = `127.0.0.1:${yield* freePort}`;
				const tunnel = yield* spawner
					.spawn(
						ChildProcess.make(
							command,
							[
								"tunnel",
								"--no-autoupdate",
								"--url",
								`http://127.0.0.1:${port}`,
								"--metrics",
								metrics,
							],
							{ stderr: "ignore", stdin: "ignore", stdout: "ignore" }
						)
					)
					.pipe(
						Effect.mapError((error) =>
							unavailable(`cloudflared did not start: ${error.message}`)
						)
					);
				const exited = tunnel.exitCode.pipe(
					Effect.flatMap((code) =>
						unavailable(`cloudflared exited with code ${code}.`)
					),
					Effect.catchTag("PlatformError", (error) =>
						Effect.fail(unavailable(error.message))
					)
				);
				const host = yield* quickTunnelHost(metrics).pipe(
					Effect.timeoutOrElse({
						duration: hostWait,
						orElse: () =>
							unavailable(
								`cloudflared named no quick tunnel host within ${Duration.format(hostWait)}.`
							),
					}),
					Effect.raceFirst(exited)
				);
				return { exited, host } satisfies Tunnel;
			});

			return Cloudflared.of({ open });
		})
	);
}
