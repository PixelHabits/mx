import { BunRuntime } from "@effect/platform-bun";
import {
	Array as Arr,
	Config,
	Console,
	Effect,
	Record as Rec,
	Redacted,
	Schema,
} from "effect";
import packageJson from "../package.json" with { type: "json" };
import { assetUrl, Manifest, pemContents } from "../src/update.ts";
import { targets } from "./build.ts";

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));

/** The release signing key, a PKCS #8 PEM in `MX_RELEASE_SIGNING_KEY`; it never enters the repository. */
export const signingKey = Effect.gen(function* () {
	// Actions passes a secret the environment lacks as an empty string.
	const pem = yield* Config.schema(
		Schema.Redacted(Schema.NonEmptyString),
		"MX_RELEASE_SIGNING_KEY"
	).pipe(
		Effect.catch(() =>
			Effect.die(
				"Set MX_RELEASE_SIGNING_KEY to the release signing key, a PKCS #8 PEM."
			)
		)
	);
	const pkcs8 = yield* Effect.fromResult(pemContents(Redacted.value(pem))).pipe(
		Effect.orDie
	);
	return yield* Effect.promise(() =>
		crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8), "Ed25519", false, [
			"sign",
		])
	);
});

/**
 * Writes the manifest of the binaries in `dist/`, their release URLs, sizes and sha256 sums, to `dist/latest.json`, and
 * its Ed25519 signature by `key` to `dist/latest.json.sig`. The sums are of the bytes in `dist/` now, so the macOS
 * binaries are signed before it runs. The GitHub release `v<version>` carries the binaries, `THIRD_PARTY_NOTICES`,
 * `LICENSE`, `mx-sync.service` and these two files.
 */
export const writeManifest = Effect.fnUntraced(function* (key: CryptoKey) {
	const { version } = packageJson;
	const files = yield* Effect.forEach(targets, ({ outfile, platform }) =>
		Effect.map(
			Effect.promise(() => Bun.file(outfile).bytes()),
			(bytes) => ({
				bytes,
				platform,
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				url: assetUrl(version, outfile.slice(outfile.lastIndexOf("/") + 1)),
			})
		)
	);
	const manifest = new TextEncoder().encode(
		yield* encodeManifest({
			platforms: Rec.fromEntries(
				Arr.map(files, ({ bytes, platform, sha256, url }) => [
					platform,
					{ sha256, size: bytes.length, url },
				])
			),
			version,
		}).pipe(Effect.orDie)
	);
	const signature = yield* Effect.promise(() =>
		crypto.subtle.sign("Ed25519", key, manifest)
	);
	yield* Effect.promise(() => Bun.write("dist/latest.json", manifest));
	yield* Effect.promise(() => Bun.write("dist/latest.json.sig", signature));
	yield* Console.log(
		`Wrote dist/latest.json and dist/latest.json.sig for mx ${version}.`
	);
});

if (import.meta.main) {
	BunRuntime.runMain(Effect.flatMap(signingKey, writeManifest));
}
