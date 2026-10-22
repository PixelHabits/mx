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

/** The cloudflared release mx downloads when `MX_CLOUDFLARED` is unset and PATH holds none at or above `floor`. */
const version = "2026.10.3";

/** The first cloudflared release that rejects the compromised eMudhra intermediate certificates. */
const floor = "2026.10.2";

const meetsFloor = (found: string) => Bun.semver.satisfies(found, `>=${floor}`);

/** What `cloudflared --version` prints, as `cloudflared version 2026.10.2 (built 20261020-21:50:43)`. */
const versionLine = /^cloudflared version (\S+)/u;

/**
 * Each pinned asset's sha256, computed from the official GitHub release. The release ships the binary itself, or for
 * macOS a gzipped tarball that holds it.
 */
const releases: Partial<
	Record<
		string,
		{
			readonly format: "binary" | "tarball";
			readonly sha256: string;
			readonly url: string;
		}
	>
> = {
	"darwin-arm64": {
		format: "tarball",
		sha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
		url: `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-darwin-arm64.tgz`,
	},
	"darwin-x64": {
		format: "tarball",
		sha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
		url: `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-darwin-amd64.tgz`,
	},
	"linux-x64": {
		format: "binary",
		sha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
		url: `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-amd64`,
	},
	"win32-x64": {
		format: "binary",
		sha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
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

/** The cloudflared in a release tarball; the pinned sha256 vouches that it holds one. */
const fromTarball = (tarball: ArrayBuffer) =>
	Effect.gen(function* () {
		const files = yield* Effect.promise(() =>
			new Bun.Archive(tarball).files(executableName)
		);
		const file = files.get(executableName);
		if (file === undefined) {
			return yield* Effect.die(
				`The pinned cloudflared tarball holds no ${executableName}.`
			);
		}
		return new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
	});

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
 * Cloudflare quick tunnels through cloudflared, at `floor` or newer. mx runs the binary `MX_CLOUDFLARED` names, and
 * push is unavailable when that one reports an older version or none. Without it, mx runs the one on PATH when that one
 * reports `floor` or newer, else the pinned release it downloads once into its data folder and checks against its
 * sha256.
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
				const binary =
					release.format === "binary"
						? new Uint8Array(bytes)
						: yield* fromTarball(bytes);
				yield* fs.makeDirectory(path.dirname(managed), { recursive: true });
				const staged = yield* fs.makeTempFileScoped({
					directory: path.dirname(managed),
				});
				yield* fs.writeFile(staged, binary);
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

			/** The version a cloudflared mx did not download reports, unless it reports none mx can read. */
			const reportedVersion = (binary: string) =>
				spawner
					.string(
						ChildProcess.make(binary, ["--version"], {
							stderr: "ignore",
							stdin: "ignore",
						})
					)
					.pipe(
						Effect.map((output) =>
							Option.fromNullishOr(versionLine.exec(output)?.[1])
						),
						Effect.catchTag("PlatformError", () => Effect.succeedNone)
					);

			const executable = Effect.gen(function* () {
				if (Option.isSome(override)) {
					const binary = override.value;
					if (!(yield* fs.exists(binary))) {
						return yield* unavailable(
							`MX_CLOUDFLARED names ${binary}, which does not exist.`
						);
					}
					const found = yield* reportedVersion(binary);
					if (Option.isNone(found)) {
						return yield* unavailable(
							`MX_CLOUDFLARED names ${binary}, whose version mx could not read; mx runs only cloudflared ${floor} or newer.`
						);
					}
					if (!meetsFloor(found.value)) {
						return yield* unavailable(
							`MX_CLOUDFLARED names ${binary}, which is cloudflared ${found.value}; mx runs only ${floor} or newer.`
						);
					}
					return binary;
				}
				const onPath = Bun.which("cloudflared", { PATH: searchPath });
				if (
					onPath !== null &&
					Option.exists(yield* reportedVersion(onPath), meetsFloor)
				) {
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
