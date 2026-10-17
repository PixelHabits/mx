import {
	Array as Arr,
	Console,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
} from "effect";
import { CliError, Command, Flag, Prompt } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { agentFlag } from "./agents.ts";
import { Auth, signIn } from "./auth/auth.ts";
import { clientIdFlag, tenantFlag } from "./auth/config.ts";
import type { InstallFailed } from "./errors.ts";
import { Installer, type Removal } from "./install.ts";
import { serve } from "./mcp/server.ts";
import { Paths } from "./paths.ts";
import { Store } from "./store.ts";
import { Sync, summary } from "./sync.ts";
import { Updater } from "./update.ts";
import { Watch } from "./watch.ts";

const login = Command.make(
	"login",
	{ clientId: clientIdFlag, tenant: tenantFlag },
	(config) =>
		Effect.gen(function* () {
			yield* signIn(yield* Auth, config);
			yield* (yield* Installer).resumeSync;
		})
).pipe(
	Command.provide(
		Layer.mergeAll(Auth.layer, Installer.layer).pipe(Layer.provide(Paths.layer))
	),
	Command.withDescription(
		"Sign in to Microsoft with a device code, save the refresh token in the system's secret store, and restart mx sync with the new sign-in. mx login asks for a client id and a tenant once, or takes --client-id and --tenant, and saves them."
	)
);

/** How often mx sync checks for a newer release. */
const updateCheckInterval = Duration.days(1);

/** The background mx sync on Windows has no console, so its log also goes to a file in the state folder. */
const syncLog =
	process.platform === "win32"
		? Layer.unwrap(
				Effect.gen(function* () {
					const { state } = yield* Paths;
					const path = yield* Path.Path;
					yield* (yield* FileSystem.FileSystem).makeDirectory(state, {
						recursive: true,
					});
					return Logger.layer(
						[Logger.toFile(Logger.formatSimple, path.join(state, "sync.log"))],
						{ mergeWithExisting: true }
					);
				})
			)
		: Layer.empty;

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
			if (once) {
				yield* Console.log(summary(yield* (yield* Sync).pass));
				return;
			}
			const installer = yield* Installer;
			const updater = yield* Updater;
			yield* installer.removeOldBinaries;
			/** Ends once a newer release is installed and a fresh mx sync started from it. */
			const updates: Effect.Effect<void, InstallFailed> = updater.update.pipe(
				Effect.catchTag("UpdateFailed", (error) =>
					Effect.as(Effect.logWarning(error.message), Option.none<string>())
				),
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.sleep(updateCheckInterval).pipe(
								Effect.andThen(Effect.suspend(() => updates))
							),
						onSome: (version) =>
							Effect.logInfo(
								`Installed mx ${version}; restarting mx sync.`
							).pipe(Effect.andThen(installer.restartSync)),
					})
				)
			);
			return yield* Effect.raceFirst((yield* Watch).run, updates);
		})
).pipe(
	Command.provide(
		Layer.mergeAll(
			Sync.layer,
			Watch.layer,
			Installer.layer,
			Updater.layer,
			syncLog
		).pipe(Layer.provide(Paths.layer))
	),
	Command.withDescription(
		"Keep the local store in step with the mailbox: Graph push notifications through a cloudflared quick tunnel, and a delta pass of every folder every 5 minutes, or every 60 seconds while push is down."
	)
);

const update = Command.make("update", {}, () =>
	Effect.gen(function* () {
		const installed = yield* (yield* Updater).update;
		if (Option.isNone(installed)) {
			yield* Console.log(`mx ${packageJson.version} is the newest release.`);
			return;
		}
		yield* (yield* Installer).restartSync;
		yield* Console.log(
			`Updated mx to ${installed.value} and restarted mx sync.`
		);
	})
).pipe(
	Command.provide(
		Layer.mergeAll(Updater.layer, Installer.layer).pipe(
			Layer.provide(Paths.layer)
		)
	),
	Command.withDescription(
		"Install the newest signed release when it is newer than this one, and restart mx sync."
	)
);

const install = Command.make(
	"install",
	{ agent: agentFlag, clientId: clientIdFlag, tenant: tenantFlag },
	({ agent, clientId, tenant }) =>
		Effect.flatMap(Installer, (installer) =>
			installer.install({ agents: agent, login: { clientId, tenant } })
		)
).pipe(
	Command.provide(Installer.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Install this binary for the signed-in user, start mx sync at sign-in, add mx mcp to the MCP config of each agent chosen, and sign in when there is no saved sign-in. Run it again to reinstall."
	)
);

/** Asks on the terminal whether to remove everything in `removals`; without a terminal it fails and names `--yes`. */
const confirmed = (removals: readonly Removal[]) =>
	process.stdin.isTTY === true
		? Prompt.run(
				Prompt.Confirm({
					message: `mx uninstall removes:\n${Arr.join(
						Arr.map(removals, ({ what }) => `  - ${what}`),
						"\n"
					)}\nRemove all of this?`,
				})
			).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)))
		: Effect.fail(
				CliError.UserError.make({
					cause: undefined,
					userMessage:
						"There is no terminal to confirm the uninstall. Run mx uninstall --yes to remove everything mx uninstall lists.",
				})
			);

const uninstall = Command.make(
	"uninstall",
	{
		yes: Flag.Boolean("yes").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Remove everything without asking.")
		),
	},
	({ yes }) =>
		Effect.gen(function* () {
			const removals = yield* (yield* Installer).removals;
			if (!(yes || (yield* confirmed(removals)))) {
				yield* Console.log("mx uninstall removed nothing.");
				return;
			}
			yield* Effect.forEach(removals, ({ remove }) => remove, {
				discard: true,
			});
			yield* Console.log("Uninstalled mx.");
		})
).pipe(
	Command.provide(Installer.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Stop mx sync, and remove its registration, mx from each agent's config with every Claude Code rule that names mx, the installed binary, the client id and the tenant, the mail store, the saved sign-in, the attachment cache and the state folder. It lists them and asks first; --yes removes them without asking."
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
	Command.withSubcommands([
		login,
		sync,
		mcp,
		reindex,
		install,
		uninstall,
		update,
	])
);
