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
import { build, targets } from "./build.ts";

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));

/** The release signing key, a PKCS #8 PEM in `MX_RELEASE_SIGNING_KEY`; it never enters the repository. */
const signingKey = Effect.gen(function* () {
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
 * Builds both binaries and their third-party notices, writes the manifest of their release URLs, sizes and sha256 sums
 * to `dist/latest.json`, and its Ed25519 signature to `dist/latest.json.sig`. The GitHub release `v<version>` carries
 * all five files.
 */
const release = Effect.gen(function* () {
	const { version } = packageJson;
	const key = yield* signingKey;
	yield* build;
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

BunRuntime.runMain(release);
