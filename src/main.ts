import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Layer, Logger, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import { savedConfig } from "./auth/config.ts";
import { mx } from "./cli.ts";
import {
	CredentialFailed,
	GraphRefused,
	InstallFailed,
	LoginRequired,
	MicrosoftUnavailable,
	NewerStore,
	SignInFailed,
	SyncUnhealthy,
	UpdateFailed,
} from "./errors.ts";
import { Paths } from "./paths.ts";
import { answerQuery, queryWorker } from "./query.ts";

/** Logs go to stderr: stdout carries command output, and MCP messages under `mx mcp`. */
const platform = Layer.mergeAll(
	savedConfig.pipe(Layer.provide(Paths.layer)),
	FetchHttpClient.layer,
	Layer.succeed(Logger.LogToStderr, true)
).pipe(Layer.provideMerge(BunServices.layer));

/** A failure whose message tells the user everything, such as "Run mx login.", so it prints without a stack. */
const isExplained = Schema.is(
	Schema.Union([
		CredentialFailed,
		GraphRefused,
		InstallFailed,
		LoginRequired,
		MicrosoftUnavailable,
		NewerStore,
		SignInFailed,
		SyncUnhealthy,
		UpdateFailed,
	])
);

/** The command line renders its own usage errors; anything unexplained prints its whole cause. */
const report = (cause: Cause.Cause<unknown>) => {
	if (Cause.hasInterruptsOnly(cause)) {
		return Effect.void;
	}
	const error = Cause.squash(cause);
	if (isExplained(error)) {
		return Console.error(`mx: ${error.message}`);
	}
	return CliError.isCliError(error) ? Effect.void : Effect.logError(cause);
};

// `mx query-worker` is the child process of the query tool, so the command line neither lists nor parses it, and it
// reads no config.
if (Bun.argv[2] === queryWorker) {
	BunRuntime.runMain(answerQuery);
} else {
	Command.run(mx, { version: packageJson.version }).pipe(
		Effect.tapCause(report),
		// @effect-diagnostics-next-line strictEffectProvide:off - the process entry point.
		Effect.provide(platform),
		BunRuntime.runMain({ disableErrorReporting: true })
	);
}
