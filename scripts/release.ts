import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { build } from "./build.ts";
import { signingKey, writeManifest } from "./manifest.ts";

/**
 * Builds the binaries and their third-party notices and writes the signed manifest into `dist/`, uploading nothing.
 * The Release workflow runs the same steps, but signs and notarizes the macOS binaries between the build and the
 * manifest; here they stay as Bun wrote them, with an ad-hoc signature.
 */
const release = Effect.gen(function* () {
	const key = yield* signingKey;
	yield* build;
	yield* writeManifest(key);
});

BunRuntime.runMain(release);
