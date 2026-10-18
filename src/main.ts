import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/http";
import { savedConfig } from "./auth/config.ts";
import { run } from "./cli.ts";
import { Paths } from "./paths.ts";
import { answerQuery, queryWorker } from "./query.ts";

/** Logs go to stderr: stdout carries command output, and MCP messages under `mx mcp`. */
const platform = Layer.mergeAll(
	savedConfig.pipe(Layer.provide(Paths.layer)),
	FetchHttpClient.layer,
	Layer.succeed(Logger.LogToStderr, true)
).pipe(Layer.provideMerge(BunServices.layer));

// `mx query-worker` is the child process of the query tool, so the command line neither lists nor parses it, and it
// reads no config.
if (Bun.argv[2] === queryWorker) {
	BunRuntime.runMain(answerQuery);
} else {
	run(Bun.argv.slice(2)).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off - the process entry point.
		Effect.provide(platform),
		BunRuntime.runMain({ disableErrorReporting: true })
	);
}
