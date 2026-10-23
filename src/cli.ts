import {
	Array as Arr,
	Cause,
	Clock,
	Console,
	Duration,
	Effect,
	Layer,
	Logger,
	Option,
	Schema,
	String as Str,
	Stream,
	Terminal,
} from "effect";
import {
	Argument,
	CliError,
	Command,
	Flag,
	Prompt,
	TerminalCapabilities,
} from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { agentFlag } from "./agents.ts";
import {
	Accounts,
	aliasProblem,
	described,
	notAnAlias,
	type Target,
} from "./auth/accounts.ts";
import {
	type Account,
	AccountsFile,
	Alias,
	accountFlag,
	ask,
	askClientId,
	askTenant,
	clientIdConfig,
	clientIdFlag,
	defaultAlias,
	listed,
	noAccount,
	type SignInConfig,
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
	Refused,
	SignInFailed,
	SyncFailed,
	SyncUnhealthy,
	UpdateFailed,
} from "./errors.ts";
import { Installer, type Removal } from "./install.ts";
import { entryJson, entryText, Log, type Logged } from "./log.ts";
import { Mailboxes, mailbox } from "./mailboxes.ts";
import { serve } from "./mcp/server.ts";
import { Paths } from "./paths.ts";
import { showProgress } from "./progress.ts";
import { signInExpiredFor, statusReport } from "./status.ts";
import { Store } from "./store.ts";
import { aboutAccount, summary } from "./sync.ts";
import { InstantFromString, PlainDateFromString } from "./temporal.ts";
import { Updater } from "./update.ts";
import { unsubscribeTunnels, Watch } from "./watch.ts";
import { ownsConsole } from "./windows.ts";

/** The client id and the tenant `mx login` or `mx install` is given, when it is. */
interface Given {
	readonly clientId: Option.Option<string>;
	readonly tenant: Option.Option<string>;
}

/** An account config.json names, signed in with the client id and the tenant given, or else its own. */
const existing = (account: Account, given: Given): Target => {
	const clientId = Option.getOrElse(given.clientId, () => account.clientId);
	const tenant = Option.getOrElse(given.tenant, () => account.tenant);
	const changed = clientId !== account.clientId || tenant !== account.tenant;
	return {
		account: changed
			? { alias: account.alias, clientId, id: account.id, tenant }
			: account,
		added: false,
		changed,
	};
};

/**
 * What a new account signs in with: the client id and the tenant given, or else `MX_CLIENT_ID` and `MX_TENANT`, or else
 * mx asks on a terminal, where Enter keeps the first account's client id. Without a terminal a new account signs in with
 * the first account's client id.
 */
const newSettings = Effect.fnUntraced(function* (
	saved: readonly Account[],
	given: Given
) {
	const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities;
	const kept = Option.map(Arr.head(saved), (first) => first.clientId);
	const clientId = Option.isSome(given.clientId)
		? given.clientId.value
		: yield* Option.match(yield* clientIdConfig, {
				onNone: () =>
					!canPrompt && Option.isSome(kept)
						? Effect.succeed(kept.value)
						: askClientId(kept),
				onSome: Effect.succeed,
			});
	const tenant = Option.isSome(given.tenant)
		? given.tenant.value
		: yield* Option.match(yield* tenantConfig, {
				onNone: () => askTenant,
				onSome: Effect.succeed,
			});
	return { clientId, tenant } satisfies SignInConfig;
});

/** Asks for a new account's alias, refusing one that breaks the rules or that an account in `saved` has; Enter keeps `offered`. */
const askAlias = (saved: readonly Account[], offered: Option.Option<string>) =>
	ask(
		Prompt.String({
			message: Option.match(offered, {
				onNone: () => "Alias for the new account, such as work",
				onSome: (free) =>
					`Alias for the new account, such as work. Enter keeps ${free}.`,
			}),
			validate: (value) => {
				const answer = Str.trim(value) || Option.getOrElse(offered, () => "");
				return Option.match(aliasProblem(saved, answer), {
					onNone: () => Effect.succeed(answer),
					onSome: Effect.fail,
				});
			},
		}),
		"mx can't ask for the new account's alias here. Run mx login --account <alias>."
	);

/**
 * A new account at `settings`, next after the accounts `saved`, aliased `alias`, or else what the user answers on a
 * terminal, where Enter keeps the alias of its tenant while that is free, or else without a terminal the alias of its
 * tenant.
 */
const newAccount = Effect.fnUntraced(function* (
	saved: readonly Account[],
	settings: SignInConfig,
	alias: Option.Option<string>
) {
	const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities;
	const offered = Option.liftPredicate(defaultAlias(settings.tenant), (free) =>
		Option.isNone(aliasProblem(saved, free))
	);
	const chosen = yield* Option.match(alias, {
		onNone: () =>
			!canPrompt && Option.isSome(offered)
				? Effect.succeed(offered.value)
				: askAlias(saved, offered),
		onSome: Effect.succeed,
	});
	const id =
		Arr.reduce(saved, 0, (last, account) => Math.max(last, account.id)) + 1;
	return {
		account: { alias: chosen, id, ...settings },
		added: true,
		changed: false,
	} satisfies Target;
});

/**
 * On a terminal, asks whether to add another account, and signs in each one the user adds, until the answer is no. An
 * added account signs in with `MX_CLIENT_ID` and `MX_TENANT`, or else mx asks, where Enter keeps the first account's
 * client id.
 */
const addAccounts = Effect.gen(function* () {
	const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities;
	const accounts = yield* Accounts;
	const file = yield* AccountsFile;
	const another = Prompt.run(
		Prompt.Confirm({ message: "Add another Microsoft 365 account?" })
	).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));
	while (canPrompt && (yield* another)) {
		const saved = yield* file.read;
		const settings = yield* newSettings(saved, {
			clientId: Option.none(),
			tenant: Option.none(),
		});
		yield* accounts.signIn(yield* newAccount(saved, settings, Option.none()));
	}
});

/**
 * What `mx login` signs in to: the account `--account` names, or a new one by that alias; without it, the one account,
 * a new one aliased after its tenant when there is none, or else the one the user picks on a terminal.
 */
const loginTarget = Effect.fnUntraced(function* (
	saved: readonly Account[],
	{ account, ...given }: Given & { readonly account: Option.Option<string> }
) {
	if (Option.isSome(account)) {
		const named = Arr.findFirst(saved, ({ alias }) => alias === account.value);
		if (Option.isSome(named)) {
			return existing(named.value, given);
		}
		if (!Schema.is(Alias)(account.value)) {
			return yield* notAnAlias(account.value);
		}
		return yield* newAccount(saved, yield* newSettings(saved, given), account);
	}
	if (!Arr.isReadonlyArrayNonEmpty(saved)) {
		const settings = yield* newSettings(saved, given);
		return yield* newAccount(
			saved,
			settings,
			Option.some(defaultAlias(settings.tenant))
		);
	}
	const [first, ...others] = saved;
	if (!Arr.isReadonlyArrayNonEmpty(others)) {
		return existing(first, given);
	}
	const chosen = yield* ask(
		Prompt.Select({
			choices: [
				...Arr.map(saved, (each) => ({
					title: described(each),
					value: Option.some(each),
				})),
				{ title: "Add an account", value: Option.none<Account>() },
			],
			message: "Which account do you want to sign in to?",
		}),
		`mx can't ask which account to sign in to here. Run mx login --account <alias>. The accounts are ${listed.format(Arr.map(saved, ({ alias }) => alias))}.`
	);
	return Option.isSome(chosen)
		? existing(chosen.value, given)
		: yield* newAccount(saved, yield* newSettings(saved, given), Option.none());
});

/**
 * The first sync of every account in `accounts` whose store has not finished one, all at once, in the foreground with
 * the progress of each after its alias when there are several.
 */
const firstSyncs = (accounts: readonly Account[]) =>
	Effect.gen(function* () {
		const several = accounts.length > 1;
		const passes = yield* Effect.forEach(accounts, (account) =>
			Effect.map(mailbox(account.id), (services) => ({
				about: aboutAccount(several, account.alias),
				finished: services.sync.finishedFirstPass,
				pass: services.sync.passWithProgress,
			}))
		);
		yield* (yield* showProgress)(
			yield* Effect.filter(passes, ({ finished }) =>
				Effect.map(finished, (done) => !done)
			)
		);
	}).pipe(Effect.scoped);

const login = Command.make(
	"login",
	{ account: accountFlag, clientId: clientIdFlag, tenant: tenantFlag },
	(flags) =>
		Effect.gen(function* () {
			const file = yield* AccountsFile;
			const target = yield* loginTarget(yield* file.read, flags);
			yield* (yield* Accounts).signIn(target);
			const accounts = yield* file.read;
			const joined = target.added && accounts.length > 1;
			if (joined) {
				yield* Console.log(
					`The accounts are ${listed.format(Arr.map(accounts, described))}. To rename one, run mx rename <alias> <new alias>.\nRestart your agents so they see the new account.`
				);
			}
			const resumed = yield* (yield* Installer).resumeSync;
			if (joined) {
				yield* Console.log(
					resumed
						? `Added ${target.account.alias}. mx sync copies its mail in the background. Run mx status to see how far it has got.`
						: `Added ${target.account.alias}. mx sync is not set up here, so nothing copies its mail yet. Run mx install to start it.`
				);
			}
		})
).pipe(
	Command.provide(
		Layer.mergeAll(Accounts.layer, AccountsFile.layer, Installer.layer).pipe(
			Layer.provide(Paths.layer)
		)
	),
	Command.withDescription(
		"Sign in to Microsoft with a device code, save the refresh token in the system's secret store, and restart mx sync with the new sign-in. mx login asks for a client id and a tenant once for each account, or takes --client-id and --tenant, and saves them. --account names the account: an alias mx has signs it in again, and a new alias adds an account. mx sync then copies the new account's mail in the background, and mx status shows how far it has got; where mx install has not set up mx sync, mx login says to run mx install. Without --account, mx signs in to the one account, or asks which when there are several."
	)
);

const rename = Command.make(
	"rename",
	{
		from: Argument.String("alias").pipe(
			Argument.withDescription("The alias the account has.")
		),
		to: Argument.String("new-alias").pipe(
			Argument.withDescription("The alias to give it.")
		),
	},
	({ from, to }) =>
		Effect.gen(function* () {
			yield* (yield* Accounts).rename(from, to);
			yield* Console.log(`Renamed ${from} to ${to}.`);
		})
).pipe(
	Command.provide(Accounts.layer.pipe(Layer.provide(Paths.layer))),
	Command.withDescription(
		"Give an account another alias. An alias is up to 20 lowercase letters, digits and hyphens, and starts with a letter."
	)
);

const logout = Command.make(
	"logout",
	{
		account: Flag.String("account").pipe(
			Flag.withDescription("The alias of the account to remove.")
		),
		yes: Flag.Boolean("yes").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Remove it without asking.")
		),
	},
	({ account: alias, yes }) =>
		Effect.gen(function* () {
			const file = yield* AccountsFile;
			const saved = yield* file.read;
			const account = yield* Option.match(
				Arr.findFirst(saved, (each) => each.alias === alias),
				{
					onNone: () => noAccount(alias, saved),
					onSome: (found) => Effect.succeed(found),
				}
			);
			if (saved.length === 1) {
				return yield* Refused.make({
					message: `${alias} is the only account. To remove it with the rest of mx, run mx uninstall.`,
				});
			}
			const confirmed =
				yes ||
				(yield* ask(
					Prompt.Confirm({
						message: `mx logout removes ${described(account)} from mx:\n  - its saved sign-in\n  - its entry in config.json\n  - the copy of its mail on this computer\nIts mailbox in Microsoft 365 stays as it is. Remove ${alias}?`,
					}),
					`mx can't ask you to confirm the logout here. Run mx logout --account ${alias} --yes.`
				).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false))));
			if (!confirmed) {
				yield* Console.log("mx logout removed nothing.");
				return;
			}
			// config.json names the account until its entry goes last, so a logout that stops partway leaves an account that
			// mx logout run again, or mx uninstall, finds and removes the rest of. The subscriptions go while the sign-in that
			// deletes them is still saved.
			yield* (yield* Store).removeAccount(account.id);
			yield* Effect.scoped(
				Effect.flatMap(mailbox(account.id), ({ graph }) =>
					unsubscribeTunnels(graph, new Set())
				)
			).pipe(
				// Without a working sign-in, as after a logout that stopped once it deleted it, nothing can delete them; Graph
				// drops them within 3 days.
				Effect.catchTag("LoginRequired", () => Effect.void)
			);
			yield* (yield* Credentials).remove(account.id);
			yield* file.write(
				Arr.filter(yield* file.read, ({ id }) => id !== account.id)
			);
			yield* Console.log(
				`Removed ${described(account)}: its sign-in and the copy of its mail. Its mailbox in Microsoft 365 is unchanged. Restart your agents so they see the change.`
			);
			// mx sync restarts without the account, and as it starts drops what the one that ran on filed of it again.
			yield* (yield* Installer).resumeSync;
		})
).pipe(
	Command.provide(
		Layer.mergeAll(
			AccountsFile.layer,
			Credentials.layer,
			Installer.layer,
			Mailboxes.layer,
			Store.layer
		).pipe(Layer.provide(Paths.layer))
	),
	Command.withDescription(
		"Remove an account from mx: the copy of its mail on this computer, its push subscriptions, its saved sign-in, and last its entry in config.json; then restart mx sync. A logout that stops partway finishes when run again. The mailbox in Microsoft 365 stays as it is. mx keeps its last account; mx uninstall removes it with the rest of mx. It lists what it removes and asks first; --yes removes it without asking."
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
				const accounts = yield* (yield* AccountsFile).read;
				if (!Arr.isReadonlyArrayNonEmpty(accounts)) {
					return yield* LoginRequired.make({ reason: "mx has no account." });
				}
				const several = accounts.length > 1;
				// Every account gets its pass, so one account's failure stops only that account.
				return yield* Effect.validate(
					accounts,
					(account) => {
						const about = aboutAccount(several, account.alias);
						return Effect.gen(function* () {
							const { pass } = (yield* mailbox(account.id)).sync;
							yield* Console.log(about(summary(yield* pass)));
						}).pipe(
							Effect.scoped,
							Effect.mapError((error) => ({
								error,
								line: about(
									error._tag === "LoginRequired"
										? signInExpiredFor(account.alias)
										: error.message
								),
							}))
						);
					},
					{ discard: true }
				).pipe(
					Effect.mapError((failures) =>
						several
							? SyncFailed.make({
									message: Arr.join(
										Arr.map(failures, ({ line }) => line),
										"\n"
									),
								})
							: Arr.headNonEmpty(failures).error
					)
				);
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
			Mailboxes.layer,
			AccountsFile.layer,
			Watch.layer,
			Installer.layer,
			Updater.layer,
			syncLog
		).pipe(Layer.provide(Paths.layer))
	),
	Command.withDescription(
		"Keep the local store in step with every account's mailbox: Graph push notifications through one cloudflared quick tunnel, and a delta pass of every folder every 5 minutes, or every 60 seconds while push is down. An account whose sign-in expires stops, and the others go on."
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
	({ agent, ...given }) =>
		Effect.gen(function* () {
			const accounts = yield* Accounts;
			const file = yield* AccountsFile;
			const saved = yield* file.read;
			// A new first account's client id and tenant are settled before anything changes, and its alias as it signs in.
			const first = yield* Option.match(Arr.head(saved), {
				onNone: () =>
					Effect.map(newSettings(saved, given), (settings) =>
						newAccount(saved, settings, Option.none())
					),
				onSome: (account) =>
					Effect.succeed(Effect.succeed(existing(account, given))),
			});
			yield* (yield* Installer).install({
				agents: agent,
				// Every account whose first sync is unfinished gets it here, as one just signed in or one a stopped mx install left.
				firstSync: Effect.flatMap(file.read, firstSyncs),
				login: Effect.gen(function* () {
					const target = yield* first;
					if (
						target.added ||
						target.changed ||
						!(yield* accounts.signedIn(target.account.id))
					) {
						yield* accounts.signIn(target);
						yield* addAccounts;
					}
				}),
			});
		})
).pipe(
	Command.provide(
		Layer.mergeAll(
			Installer.layer,
			Mailboxes.layer,
			Accounts.layer,
			AccountsFile.layer
		).pipe(Layer.provide(Paths.layer))
	),
	Command.withDescription(
		"Install this binary for the signed-in user, start mx sync at sign-in, add mx mcp to the MCP config of each agent chosen, and sign in to the first account when it has no saved sign-in, asking on a terminal for the alias of a new one. On a terminal, after each sign-in it asks whether to add another account. Then every account whose mail has not synced once syncs in the foreground, all at once, each with a progress line of its own, before mx install starts mx sync. A stopped first sync resumes on the next run. Run it again to reinstall."
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
		"Stop mx sync, and remove its registration, mx from each agent's config with every Claude Code rule that names mx, each account's saved sign-in, the mail store, the attachment cache, the state folder with the tool call log, the accounts with their client ids and tenants, and last the installed binary. It lists them and asks first; --yes removes them without asking."
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
		const store = yield* Store;
		const heartbeat = yield* store.heartbeat;
		const syncs = yield* store.accountSyncs;
		const credentials = yield* Credentials;
		const accounts = yield* Effect.forEach(
			yield* (yield* AccountsFile).read,
			(account) =>
				credentials.read(account.id).pipe(
					Effect.as({ line: "saved", problem: Option.none<string>() }),
					Effect.catchTags({
						CredentialFailed: (error) =>
							Effect.succeed({
								line: `unknown. ${error.message}`,
								problem: Option.some(error.message),
							}),
						LoginRequired: () =>
							Effect.succeed({
								line: `none saved. Run mx login --account ${account.alias}.`,
								problem: Option.none<string>(),
							}),
					}),
					Effect.flatMap((signIn) =>
						Effect.map(store.folders(account.id), (folders) => ({
							account,
							folders: {
								done: Arr.filter(folders, ({ deltaLink }) =>
									Option.isSome(deltaLink)
								).length,
								listed: folders.length,
							},
							signIn,
							sync: Option.fromUndefinedOr(syncs.get(account.id)),
						}))
					)
				)
		);
		const now = Temporal.Instant.fromEpochMilliseconds(
			yield* Clock.currentTimeMillis
		);
		const report = statusReport({
			accounts,
			heartbeat,
			now,
			version: packageJson.version,
		});
		yield* Console.log(report.text);
		if (Option.isSome(report.problem)) {
			return yield* SyncUnhealthy.make({ message: report.problem.value });
		}
	})
).pipe(
	Command.provide(
		Layer.mergeAll(Store.layer, Credentials.layer, AccountsFile.layer).pipe(
			Layer.provide(Paths.layer)
		)
	),
	Command.withDescription(
		"Say whether mx sync is running and its version; when mail last synced, how far a first sync has got while it runs, its mode and its last error, for each account when there are several; and for each account who signed in to it, whether a sign-in is saved, its client id and its tenant. Exits non-zero when sync is not running, an account's mail is out of date, or sync reports an error."
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
		logout,
		rename,
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
		Refused,
		SignInFailed,
		SyncFailed,
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
