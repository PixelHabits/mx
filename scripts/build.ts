import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";

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
 * Compiles each target minified and with bytecode, and writes its source map next to it, as `dist/mx-linux-x64.map`;
 * a failed build fails loudly. Bytecode builds CommonJS unless told otherwise, and the bundle uses `import.meta`, so
 * the format is ESM. The binary reads no `.env` or `bunfig.toml` from the folder it runs in, and no environment
 * variable is inlined.
 */
export const build = Effect.forEach(
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

if (import.meta.main) {
	BunRuntime.runMain(build);
}
