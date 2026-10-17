import { Console, Effect, Layer, Schedule } from "effect";
import { Command, Flag } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { Auth } from "./auth/auth.ts";
import { clientIdFlag, tenantFlag } from "./auth/config.ts";
import { serve } from "./mcp/server.ts";
import { Paths } from "./paths.ts";
import { Store } from "./store.ts";
import { type Pass, Sync } from "./sync.ts";

/** How long `mx sync` waits between passes. */
const syncInterval = "60 seconds";

const summary = ({ folders, removed, saved }: Pass) =>
	`Synced ${folders} folders: ${saved} messages saved, ${removed} removed.`;

const login = Command.make(
	"login",
	{ clientId: clientIdFlag, tenant: tenantFlag },
	(config) =>
		Effect.gen(function* () {
			const auth = yield* Auth;
			const { complete, url, userCode } = yield* auth.startLogin(config);
			yield* Console.log(`Open ${url} and enter the code ${userCode}.`);
			yield* complete;
			yield* Console.log("Signed in. The refresh token is saved.");
		})
).pipe(
	Command.provide(Auth.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Sign in to Microsoft with a device code and save the refresh token in the system's secret store. mx login asks for a client id and a tenant once, or takes --client-id and --tenant, and saves them."
	)
);

const sync = Command.make(
	"sync",
	{
		once: Flag.Boolean("once").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Run one pass and exit.")
		),
	},
	({ once }) =>
		Effect.gen(function* () {
			const { pass } = yield* Sync;
			if (once) {
				yield* Console.log(summary(yield* pass));
				return;
			}
			/** An outage waits for the next pass; a refused sign-in or anything else stops the service loudly. */
			yield* pass.pipe(
				Effect.tap((done) =>
					done.saved + done.removed > 0
						? Effect.logInfo(summary(done))
						: Effect.void
				),
				Effect.catchTag("MicrosoftUnavailable", (error) =>
					Effect.logWarning(error.message)
				),
				Effect.repeat(Schedule.spaced(syncInterval))
			);
		})
).pipe(
	Command.provide(Sync.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Keep the local store in step with the mailbox through Graph delta, every 60 seconds."
	)
);

const mcp = Command.make("mcp", {}, () =>
	Layer.launch(serve(packageJson.version))
).pipe(
	Command.withDescription(
		"Serve the mailbox tools to an AI agent over MCP on stdio."
	)
);

const reindex = Command.make("reindex", {}, () =>
	Effect.gen(function* () {
		const count = yield* (yield* Store).reindex;
		yield* Console.log(`Reindexed ${count} messages.`);
	})
).pipe(
	Command.provide(Store.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Rebuild the full-text index from the stored messages."
	)
);

export const mx = Command.make("mx").pipe(
	Command.withDescription(
		"Read and manage a Microsoft 365 mailbox through Microsoft Graph."
	),
	Command.withSubcommands([login, sync, mcp, reindex])
);
