import { BunRuntime } from "@effect/platform-bun";
import { Array as Arr, Console, Effect, Record as Rec } from "effect";
import { pemContents } from "../src/update.ts";
import { notices, noticesFile } from "./notices.ts";

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
 * Compiles each target minified and with bytecode, writes its source map next to it, as `dist/mx-linux-x64.map`, and
 * writes the third-party notices of what the binaries hold next to them. The release public key and the version in
 * `package.json` come in through their imports. The build fails before it compiles when a valid public key is missing,
 * and a failed build fails loudly. Bytecode builds CommonJS unless told otherwise, and the bundle uses `import.meta`,
 * so the format is ESM. The binary reads no `.env` or `bunfig.toml` from the folder it runs in, and no environment
 * variable is inlined.
 */
const compile = Effect.fnUntraced(function* (
	chosen: readonly (typeof targets)[number][]
) {
	yield* checkPublicKey;
	const inputs = yield* Effect.forEach(chosen, ({ outfile, target }) =>
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
				metafile: true,
				minify: true,
				sourcemap: "linked",
			})
		).pipe(
			Effect.flatMap(({ metafile }) =>
				metafile === undefined
					? Effect.die(`Bun.build answered no metafile for ${outfile}.`)
					: Effect.succeed(Rec.keys(metafile.inputs))
			),
			Effect.tap(Console.log(`Built ${outfile}.`))
		)
	);
	const text = yield* notices(Arr.flatten(inputs));
	yield* Effect.promise(() => Bun.write(noticesFile, text));
	yield* Console.log(`Wrote ${noticesFile}.`);
});

export const build = compile(targets);

/** `bun run build linux-x64` builds only the platforms it names, as the Arch package does. */
const platformsNamed = Effect.gen(function* () {
	const named = Bun.argv.slice(2);
	const unknown = Arr.filter(
		named,
		(name) => !Arr.some(targets, ({ platform }) => platform === name)
	);
	if (Arr.isArrayNonEmpty(unknown)) {
		return yield* Effect.die(
			`Unknown platform ${Arr.join(unknown, ", ")}; mx builds ${Arr.join(
				Arr.map(targets, ({ platform }) => platform),
				", "
			)}.`
		);
	}
	return Arr.isArrayNonEmpty(named)
		? Arr.filter(targets, ({ platform }) => named.includes(platform))
		: targets;
});

if (import.meta.main) {
	BunRuntime.runMain(Effect.flatMap(platformsNamed, compile));
}
