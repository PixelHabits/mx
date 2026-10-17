import {
	Context,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Schema,
} from "effect";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import releasePublicKey from "../release/public-key.pem" with { type: "text" };
import { UpdateFailed } from "./errors.ts";
import { policy } from "./http-policy.ts";
import { Installer } from "./install.ts";
import { Paths } from "./paths.ts";

/** The GitHub repository whose releases carry mx's binaries and their signed manifest. */
const releases = "https://github.com/PixelHabits/mx/releases";

/**
 * The signed manifest of the newest published release. GitHub's `latest` skips draft releases, so a release shows here
 * only once it is published with all its files.
 */
const manifestUrl = `${releases}/latest/download/latest.json`;

/** The manifest's Ed25519 signature, over its exact bytes. */
const signatureUrl = `${manifestUrl}.sig`;

/** Where release `version` keeps the file `asset`. */
export const assetUrl = (version: string, asset: string) =>
	`${releases}/download/v${version}/${asset}`;

/** A binary is about 100 MB at most. */
const downloadDeadline = Duration.minutes(10);

/** The manifest's key for the binary this machine runs, such as `linux-x64` or `windows-x64`. */
export const platformKey = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

const pemArmor = /-----[A-Z ]+-----|\s/gu;

/** The DER bytes inside a PEM block, such as a SPKI public key or a PKCS #8 private key. */
export const pemContents = (pem: string) =>
	Base64.decode(pem.replaceAll(pemArmor, ""));

const sha256Hex = /^[0-9a-f]{64}$/u;
const semver = /^\d+\.\d+\.\d+$/u;

export const Manifest = Schema.Struct({
	platforms: Schema.Record(
		Schema.String,
		Schema.Struct({
			sha256: Schema.String.check(Schema.isPattern(sha256Hex)),
			size: Schema.Int,
			url: Schema.String,
		})
	),
	version: Schema.String.check(Schema.isPattern(semver)),
});
export type Manifest = typeof Manifest.Type;

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));

/**
 * Updates the installed binary from the release host. It trusts only a manifest signed by the release key compiled into
 * this binary, takes only a version higher than this binary's, and installs the download only when its size and sha256
 * match the manifest.
 */
export class Updater extends Context.Service<
	Updater,
	{
		/** Installs the newest release when it is newer; answers the version it installed, or none. */
		readonly update: Effect.Effect<Option.Option<string>, UpdateFailed>;
	}
>()("mx/update/Updater") {
	static readonly layerNoDeps = Layer.effect(
		Updater,
		Effect.gen(function* () {
			const installer = yield* Installer;
			const fs = yield* FileSystem.FileSystem;
			const { bin, packaged } = yield* Paths;
			const http = policy(yield* HttpClient.HttpClient, {
				deadline: downloadDeadline,
			});
			/** A key that does not import is a defect of the build that compiled it in. */
			const spki = yield* Effect.fromResult(pemContents(releasePublicKey)).pipe(
				Effect.orDie
			);
			const releaseKey = yield* Effect.promise(() =>
				crypto.subtle.importKey(
					"spki",
					new Uint8Array(spki),
					"Ed25519",
					false,
					["verify"]
				)
			);
			const failed = (message: string) => UpdateFailed.make({ message });

			const download = (url: string) =>
				http.get(url).pipe(
					Effect.flatMap(HttpClientResponse.filterStatusOk),
					Effect.flatMap((response) => response.arrayBuffer),
					Effect.map((buffer) => new Uint8Array(buffer)),
					Effect.mapError(() => failed(`Could not download ${url}.`))
				);

			const update = Effect.gen(function* () {
				if (packaged) {
					return yield* failed(
						"mx came from the Arch package; update it with pacman."
					);
				}
				if (!(yield* fs.exists(bin).pipe(Effect.orDie))) {
					return yield* failed(
						`mx is not installed at ${bin}; run mx install first.`
					);
				}
				const [manifestBytes, signature] = yield* Effect.all(
					[download(manifestUrl), download(signatureUrl)],
					{ concurrency: 2 }
				);
				const signed = yield* Effect.promise(() =>
					crypto.subtle.verify("Ed25519", releaseKey, signature, manifestBytes)
				);
				if (!signed) {
					return yield* failed(
						"The release manifest's signature does not match the release key; nothing was installed."
					);
				}
				const manifest = yield* decodeManifest(
					new TextDecoder().decode(manifestBytes)
				).pipe(
					Effect.mapError(() =>
						failed("The signed release manifest is malformed.")
					)
				);
				if (Bun.semver.order(manifest.version, packageJson.version) !== 1) {
					return Option.none<string>();
				}
				const asset = manifest.platforms[platformKey];
				if (asset === undefined) {
					return yield* failed(
						`Release ${manifest.version} has no binary for ${platformKey}.`
					);
				}
				const bytes = yield* download(asset.url);
				const sha256 = new Bun.CryptoHasher("sha256")
					.update(bytes)
					.digest("hex");
				if (bytes.length !== asset.size || sha256 !== asset.sha256) {
					return yield* failed(
						`The download of ${manifest.version} has ${bytes.length} bytes and sha256 ${sha256}; the manifest says ${asset.size} bytes and ${asset.sha256}. Nothing was installed.`
					);
				}
				yield* installer
					.replaceBinary(bytes)
					.pipe(Effect.mapError((error) => failed(error.message)));
				return Option.some(manifest.version);
			}).pipe(Effect.withSpan("Updater.update"));

			return Updater.of({ update });
		})
	);

	static readonly layer = Updater.layerNoDeps.pipe(
		Layer.provide(Installer.layer)
	);
}
