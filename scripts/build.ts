import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { pemContents } from "../src/update.ts";

/** The release key's public half, committed; its private half never enters the repository. */
const publicKeyFile = "release/public-key.pem";

/**
 * Checks that the release key's public half, which the binary imports, is an Ed25519 SPKI key, so a build never ships a
 * key no release matches.
 */
const checkPublicKey = Effect.gen(function* () {
	const file = Bun.file(publicKeyFile);
	if (!(yield* Effect.promise(() => file.exists()))) {
		return yield* Effect.die(
			`${publicKeyFile} is missing; it holds the public half of the release signing key.`
		);
	}
	const pem = yield* Effect.promise(() => file.text());
	const spki = yield* Effect.fromResult(pemContents(pem)).pipe(Effect.orDie);
	yield* Effect.tryPromise(() =>
		crypto.subtle.importKey("spki", new Uint8Array(spki), "Ed25519", false, [
			"verify",
		])
	).pipe(
		Effect.catch(() =>
			Effect.die(`${publicKeyFile} is not an Ed25519 public key in SPKI PEM.`)
		)
	);
});

/** The binaries `bun run build` writes, one per platform mx supports, named by the manifest's platform keys. */
export const targets = [
	{
		outfile: "dist/mx-linux-x64",
		platform: "linux-x64",
		target: "bun-linux-x64",
	},
	{
		outfile: "dist/mx-windows-x64.exe",
		platform: "windows-x64",
		target: "bun-windows-x64",
	},
] as const;

/**
 * Compiles each target minified and with bytecode, and writes its source map next to it, as `dist/mx-linux-x64.map`.
 * The release public key and the version in `package.json` come in through their imports. The build fails before it
 * compiles when a valid public key is missing, and a failed build fails loudly. Bytecode builds CommonJS unless told
 * otherwise, and the bundle uses `import.meta`, so the format is ESM. The binary reads no `.env` or `bunfig.toml` from
 * the folder it runs in, and no environment variable is inlined.
 */
export const build = Effect.gen(function* () {
	yield* checkPublicKey;
	yield* Effect.forEach(
		targets,
		({ outfile, target }) =>
			Effect.promise(() =>
				Bun.build({
					bytecode: true,
					compile: {
						autoloadBunfig: false,
						autoloadDotenv: false,
						outfile,
						target,
					},
					entrypoints: ["src/main.ts"],
					env: "disable",
					format: "esm",
					minify: true,
					sourcemap: "linked",
				})
			).pipe(Effect.andThen(Console.log(`Built ${outfile}.`))),
		{ discard: true }
	);
});

if (import.meta.main) {
	BunRuntime.runMain(build);
}
