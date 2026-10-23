import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { AccountsFile } from "./auth/config.ts";
import { run } from "./cli.ts";
import { Paths } from "./paths.ts";
import { answerQuery, queryWorker } from "./query.ts";

/** Logs go to stderr: stdout carries command output, and MCP messages under `mx mcp`. */
const platform = Layer.mergeAll(
	FetchHttpClient.layer,
	Layer.succeed(Logger.LogToStderr, true),
	TerminalCapabilities.layer
).pipe(Layer.provideMerge(BunServices.layer));

// `mx query-worker` is the child process of the query tool, so the command line neither lists nor parses it; it reads
// only the accounts' aliases in config.json.
if (Bun.argv[2] === queryWorker) {
	answerQuery.pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off - the entry point of the query worker process.
		Effect.provide(
			AccountsFile.layer.pipe(
				Layer.provide(Paths.layer),
				Layer.provideMerge(BunServices.layer)
			)
		),
		BunRuntime.runMain
	);
} else {
	run(Bun.argv.slice(2)).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off - the process entry point.
		Effect.provide(platform),
		BunRuntime.runMain({ disableErrorReporting: true })
	);
}
