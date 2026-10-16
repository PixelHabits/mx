import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };

const mx = Command.make("mx").pipe(
	Command.withDescription("Read and manage a Microsoft 365 mailbox.")
);

Command.run(mx, { version: packageJson.version }).pipe(
	// @effect-diagnostics-next-line strictEffectProvide:off - the process entry point.
	Effect.provide(BunServices.layer),
	BunRuntime.runMain
);
