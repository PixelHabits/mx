import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";

/** Compiles `dist/mx`. The binary reads no `.env` or `bunfig.toml` from the folder it runs in, and no environment variable is inlined. */
export const build = Effect.gen(function* () {
	yield* Effect.promise(() =>
		Bun.build({
			compile: {
				autoloadBunfig: false,
				autoloadDotenv: false,
				outfile: "dist/mx",
			},
			entrypoints: ["src/main.ts"],
			env: "disable",
		})
	);
	yield* Console.log("Built dist/mx.");
});

if (import.meta.main) {
	BunRuntime.runMain(build);
}
