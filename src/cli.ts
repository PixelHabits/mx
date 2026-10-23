import {
	Array as Arr,
	Cause,
	Clock,
	Config,
	Console,
	Duration,
	Effect,
	Layer,
	Logger,
	Option,
	Schema,
	Stream,
	Terminal,
} from "effect";
import {
	CliError,
	Command,
	Flag,
	Prompt,
	TerminalCapabilities,
} from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import packageJson from "../package.json" with { type: "json" };
import { agentFlag } from "./agents.ts";
import { Auth, signIn } from "./auth/auth.ts";
import {
	clientIdConfig,
	clientIdFlag,
	organizations,
	tenantConfig,
	tenantFlag,
} from "./auth/config.ts";
import { Credentials } from "./auth/credentials.ts";
import { banner } from "./banner.ts";
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
import { Installer, type Removal } from "./install.ts";
import { entryJson, entryText, Log, type Logged } from "./log.ts";
import { serve } from "./mcp/server.ts";
import { Paths } from "./paths.ts";
import { showProgress } from "./progress.ts";
import { statusReport } from "./status.ts";
import { Store } from "./store.ts";
import { Sync, summary } from "./sync.ts";
import { InstantFromString, PlainDateFromString } from "./temporal.ts";
import { Updater } from "./update.ts";
import { Watch } from "./watch.ts";
import { ownsConsole } from "./windows.ts";

const login = Command.make(
	"login",
	{ clientId: clientIdFlag, tenant: tenantFlag },
	(config) =>
		Effect.gen(function* () {
			yield* signIn(
				{
					auth: yield* Auth,
					spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
					terminal: yield* Terminal.Terminal,
				},
				config
			);
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

/**
 * mx sync's log lines go to the log as sync lines. On Linux they also go to stderr, which journald keeps within its own
 * size limit. On macOS launchd appends stderr to sync.log and never caps it, so there they go to the log alone, and
 * sync.log keeps only what mx prints as it fails. On Windows the background mxw.exe has no console.
 */
const syncLog = Layer.suspend(() =>
	Logger.layer([Log.useSync(({ syncLogger }) => syncLogger)], {
		mergeWithExisting: process.platform !== "darwin",
	})
).pipe(Layer.provide(Log.layer));

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
		Effect.gen(function* () {
			const { finishedFirstPass, passWithProgress } = yield* Sync;
			const show = yield* showProgress;
			yield* (yield* Installer).install({
				agents: agent,
				firstSync: Effect.gen(function* () {
					if (!(yield* finishedFirstPass)) {
						yield* show(passWithProgress);
					}
				}),
				login: { clientId, tenant },
			});
		})
).pipe(
	Command.provide(
		Layer.mergeAll(Installer.layer, Sync.layer).pipe(Layer.provide(Paths.layer))
	),
	Command.withDescription(
		"Install this binary for the signed-in user, start mx sync at sign-in, add mx mcp to the MCP config of each agent chosen, and sign in when there is no saved sign-in. Until mail has synced once, it syncs in the foreground with its progress before it starts mx sync; stopped, it resumes on the next run. Run it again to reinstall."
	)
);

/** Asks on the terminal whether to remove everything in `removals`; without a terminal it fails and names `--yes`. */
const confirmed = (removals: readonly Removal[]) =>
	Effect.flatMap(TerminalCapabilities.TerminalCapabilities, ({ canPrompt }) =>
		canPrompt
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
							"mx can't ask you to confirm the uninstall here. Run mx uninstall --yes to remove everything mx uninstall lists.",
					})
				)
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
		"Stop mx sync, and remove its registration, mx from each agent's config with every Claude Code rule that names mx, the installed binary, the client id and the tenant, the mail store, the saved sign-in, the attachment cache, and the state folder with the tool call log. It lists them and asks first; --yes removes them without asking."
	)
);

const mcp = Command.make("mcp", {}, () =>
	Layer.launch(serve(packageJson.version))
).pipe(
	Command.withDescription(
		"Serve the mailbox tools to an AI agent over MCP on stdio."
	)
);

const status = Command.make("status", {}, () =>
	Effect.gen(function* () {
		const heartbeat = yield* (yield* Store).heartbeat;
		const saved = yield* (yield* Credentials).read.pipe(
			Effect.as({ line: "saved", problem: Option.none<string>() }),
			Effect.catchTags({
				CredentialFailed: (error) =>
					Effect.succeed({
						line: `unknown. ${error.message}`,
						problem: Option.some(error.message),
					}),
				LoginRequired: () =>
					Effect.succeed({
						line: "none saved. Run mx login.",
						problem: Option.none<string>(),
					}),
			})
		);
		const now = Temporal.Instant.fromEpochMilliseconds(
			yield* Clock.currentTimeMillis
		);
		const report = statusReport({
			clientId: Option.isSome(
				yield* Config.option(clientIdConfig).pipe(Effect.orDie)
			),
			heartbeat,
			now,
			signIn: saved,
			tenant: yield* tenantConfig.pipe(
				Config.withDefault(organizations),
				Effect.orDie
			),
			version: packageJson.version,
		});
		yield* Console.log(report.text);
		if (Option.isSome(report.problem)) {
			return yield* SyncUnhealthy.make({ message: report.problem.value });
		}
	})
).pipe(
	Command.provide(
		Layer.mergeAll(Store.layer, Credentials.layer).pipe(
			Layer.provide(Paths.layer)
		)
	),
	Command.withDescription(
		"Say whether mx sync is running, when it last synced, its mode and version, whether a sign-in is saved and a client id is set, the tenant, and its last error. Exits non-zero when sync is not running, mail is out of date, or sync reports an error."
	)
);

/** How often `mx log --follow` looks for new rows. */
const followInterval = Duration.seconds(1);

/** A date in the local time zone, which starts at its midnight, or an instant. */
const Since = Schema.Union([InstantFromString, PlainDateFromString]);

const log = Command.make(
	"log",
	{
		follow: Flag.Boolean("follow").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"After the rows, print each new row as it arrives, until Ctrl+C."
			)
		),
		json: Flag.Boolean("json").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Print each row as one JSON object with every field."
			)
		),
		limit: Flag.Int("limit").pipe(
			Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
			Flag.withDefault(20),
			Flag.withDescription(
				"How many of the newest rows to print, 20 unless given."
			)
		),
		since: Flag.String("since").pipe(
			Flag.withSchema(Since),
			Flag.optional,
			Flag.withDescription(
				"Only rows from this date or instant on, such as 2026-10-19 or 2026-10-19T14:00:00Z."
			)
		),
		sync: Flag.Boolean("sync").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Include the lines mx sync logs.")
		),
		tool: Flag.String("tool").pipe(
			Flag.optional,
			Flag.withDescription("Only the calls of this tool or prompt.")
		),
	},
	({ follow, json, limit, since, sync: withSync, tool }) =>
		Effect.gen(function* () {
			const { read } = yield* Log;
			const filter = {
				name: tool,
				since: Option.map(since, (start) =>
					start instanceof Temporal.PlainDate
						? start.toZonedDateTime(Temporal.Now.timeZoneId()).toInstant()
						: start
				),
				sync: withSync,
			};
			/** Prints `rows` and answers the id of the last one, or `last` when there are none. */
			const print = (rows: readonly Logged[], last: Option.Option<number>) =>
				Effect.as(
					Effect.forEach(
						rows,
						(row) =>
							Effect.flatMap(
								json ? entryJson(row) : entryText(row),
								Console.log
							),
						{ discard: true }
					),
					Option.orElse(
						Option.map(Arr.last(rows), ({ id }) => id),
						() => last
					)
				);
			const printed = yield* Effect.flatMap(
				read({ ...filter, after: Option.none(), limit: Option.some(limit) }),
				(rows) => print(rows, Option.none())
			);
			if (!follow) {
				return;
			}
			const followFrom = (last: Option.Option<number>): Effect.Effect<never> =>
				Effect.sleep(followInterval).pipe(
					Effect.andThen(
						read({ ...filter, after: last, limit: Option.none() })
					),
					Effect.flatMap((rows) => print(rows, last)),
					Effect.flatMap(followFrom)
				);
			return yield* followFrom(printed);
		})
).pipe(
	Command.provide(Log.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Print the log of every tool call and prompt, oldest first: when, which agent, what it sent, what mx answered, whether it failed, and how long it took. --sync includes the lines mx sync logs."
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

/** A bare `mx` shows the help, as Effect's command line does for a command without a handler, after the banner. */
export const mx = Command.make("mx", {}, () =>
	Effect.andThen(
		banner,
		Effect.fail(CliError.ShowHelp.make({ commandPath: ["mx"], errors: [] }))
	)
).pipe(
	Command.withDescription(
		"Read and manage a Microsoft 365 mailbox through Microsoft Graph."
	),
	Command.withSubcommands([
		login,
		sync,
		status,
		mcp,
		log,
		reindex,
		install,
		uninstall,
		update,
	])
);

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

/** Asks for Enter, and waits for it or for the input to end, as Esc and Ctrl+C end it. */
const pressEnterToClose = Effect.gen(function* () {
	const terminal = yield* Terminal.Terminal;
	yield* terminal.display("Press Enter to close.");
	yield* Stream.fromQueue(yield* terminal.readInput).pipe(
		Stream.takeUntil(
			({ key }) => key.name === "return" || key.name === "enter"
		),
		Stream.runDrain
	);
}).pipe(Effect.scoped, Effect.orDie);

/**
 * Runs mx on `args` as its process does, and reports a failure. On a double-click, Explorer starts mx.exe with no
 * arguments in a console of its own, which Windows closes as soon as mx exits. There mx plays the banner, runs
 * `mx install`, and waits for Enter however that ends, so the user can read how it went.
 */
export const run = Effect.fnUntraced(function* (args: readonly string[]) {
	const command = Command.runWith(mx, { version: packageJson.version });
	if (
		!(args.length === 0 && process.platform === "win32" && (yield* ownsConsole))
	) {
		return yield* command(args).pipe(Effect.tapCause(report));
	}
	yield* banner;
	return yield* command(["install"]).pipe(
		Effect.tapCause(report),
		Effect.ensuring(pressEnterToClose)
	);
});
