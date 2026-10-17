import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { unit } from "../src/install.ts";

/** Prints the systemd user unit for the binary at the path given, as `bun scripts/unit.ts /usr/bin/mx`. */
const print = Effect.gen(function* () {
	const [bin] = Bun.argv.slice(2);
	if (bin === undefined) {
		return yield* Effect.die(
			"Give the path of the binary: bun scripts/unit.ts /usr/bin/mx"
		);
	}
	yield* Effect.promise(() => Bun.write(Bun.stdout, unit(bin)));
});

BunRuntime.runMain(print);
