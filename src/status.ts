import { Array as Arr, Duration, Option } from "effect";
import type { Account } from "./auth/config.ts";
import type { AccountSync, Heartbeat } from "./store.ts";
import { localTime } from "./temporal.ts";

/** How often mx sync writes its heartbeat while it runs, however long a pass takes. */
export const beatInterval = Duration.minutes(1);

/** A heartbeat older than three beats means mx sync stopped. */
const aliveWithin = Duration.times(beatInterval, 3);

/** Mail that last synced longer ago may be out of date, since mx sync polls every folder at least every 5 minutes. */
const staleAfter = Duration.minutes(15);

/** The last error mx sync records when Microsoft refuses the saved sign-in or there is none. */
export const signInExpired = "Sign-in expired. Run mx login.";

/** The last error mx sync records for the account aliased `alias`, of several, when Microsoft refuses its sign-in or there is none. */
export const signInExpiredFor = (alias: string) =>
	`Sign-in expired. Run mx login --account ${alias}.`;

const neverRan = "⚠ mx sync has never run. Run mx status.";

/** How long before `now` the instant was, rounded down: `45 s`, `12 min`, `3 h` or `2 d`. */
export const ago = (then: Temporal.Instant, now: Temporal.Instant) => {
	const seconds = Math.max(0, Math.floor(now.since(then).total("seconds")));
	if (seconds < 60) {
		return `${seconds} s`;
	}
	if (seconds < 60 * 60) {
		return `${Math.floor(seconds / 60)} min`;
	}
	if (seconds < 24 * 60 * 60) {
		return `${Math.floor(seconds / (60 * 60))} h`;
	}
	return `${Math.floor(seconds / (24 * 60 * 60))} d`;
};

const within = (
	then: Temporal.Instant,
	now: Temporal.Instant,
	duration: Duration.Duration
) =>
	now.epochMilliseconds - then.epochMilliseconds < Duration.toMillis(duration);

const isAlive = (heartbeat: Heartbeat, now: Temporal.Instant) =>
	within(heartbeat.at, now, aliveWithin);

const isFresh = (
	lastSuccess: Option.Option<Temporal.Instant>,
	now: Temporal.Instant
) => Option.exists(lastSuccess, (at) => within(at, now, staleAfter));

const synced = (
	lastSuccess: Option.Option<Temporal.Instant>,
	now: Temporal.Instant
) =>
	Option.match(lastSuccess, {
		onNone: () => "Mail has never synced",
		onSome: (at) => `Mail last synced ${ago(at, now)} ago`,
	});

/**
 * Why mail that last synced at `lastSuccess`, with the last error `error`, may be out of date: the sign-in expired, as
 * `expired` says, mx sync is not running, or the mail last synced longer ago than `staleAfter`, with the last error when
 * there is one. None while sync runs and mail is fresh.
 */
const outOfDate = (
	{ error, lastSuccess }: Pick<AccountSync, "error" | "lastSuccess">,
	alive: boolean,
	expired: string,
	now: Temporal.Instant
): Option.Option<string> => {
	if (Option.contains(error, expired)) {
		return Option.some(expired);
	}
	if (alive && isFresh(lastSuccess, now)) {
		return Option.none();
	}
	const lastError = Option.match(error, {
		onNone: () => "",
		onSome: (message) => ` Last error: ${message}`,
	});
	return Option.some(
		`${synced(lastSuccess, now)}${alive ? "" : " and mx sync is not running"}.${lastError} Run mx status.`
	);
};

/**
 * The line a read tool puts before its answer when the store may be out of date: the sign-in expired, mx sync never ran
 * or is not running, or mail last synced longer ago than `staleAfter`, with the last error when there is one. None while
 * sync runs and mail is fresh.
 */
export const syncWarning = (
	heartbeat: Option.Option<Heartbeat>,
	now: Temporal.Instant
): Option.Option<string> =>
	Option.match(heartbeat, {
		onNone: () => Option.some(neverRan),
		onSome: (beat) =>
			Option.map(
				outOfDate(beat, isAlive(beat, now), signInExpired, now),
				(text) => `⚠ ${text}`
			),
	});

/**
 * With several accounts, the lines a read tool puts before its answer: one for each account whose mail may be out of
 * date, after its alias, as `syncWarning` words it for one, or the one line that mx sync never ran. None while sync runs
 * and every account's mail is fresh.
 */
export const accountWarnings = (
	heartbeat: Option.Option<Heartbeat>,
	accounts: readonly {
		readonly alias: string;
		readonly sync: Option.Option<AccountSync>;
	}[],
	now: Temporal.Instant
): Option.Option<string> => {
	if (Option.isNone(heartbeat)) {
		return Option.some(neverRan);
	}
	const alive = isAlive(heartbeat.value, now);
	const warnings = Arr.getSomes(
		Arr.map(accounts, ({ alias, sync }) =>
			Option.map(
				outOfDate(
					{
						error: Option.flatMap(sync, ({ error }) => error),
						lastSuccess: Option.flatMap(sync, ({ lastSuccess }) => lastSuccess),
					},
					alive,
					signInExpiredFor(alias),
					now
				),
				(text) => `⚠ ${alias}: ${text}`
			)
		)
	);
	return Arr.isReadonlyArrayNonEmpty(warnings)
		? Option.some(Arr.join(warnings, "\n"))
		: Option.none();
};

/**
 * An account as `mx status` shows it: its sign-in line, the problem when the secret store could not be read, how mx
 * sync last followed it, when it wrote that, and how many of the folders the store knows have finished their first
 * sync.
 */
export interface AccountStatus {
	readonly account: Account;
	readonly folders: { readonly done: number; readonly listed: number };
	readonly signIn: {
		readonly line: string;
		readonly problem: Option.Option<string>;
	};
	readonly sync: Option.Option<AccountSync>;
}

const lastSyncLine = (
	lastSuccess: Option.Option<Temporal.Instant>,
	now: Temporal.Instant
) =>
	`Last sync: ${Option.match(lastSuccess, {
		onNone: () => "never",
		onSome: (at) => `${localTime(at)}, ${ago(at, now)} ago`,
	})}`;

/** How far the account's first sync has got, while the store knows folders that have not finished it. */
const firstSyncLine = ({
	folders: { done, listed },
}: AccountStatus): readonly string[] =>
	done < listed ? [`First sync: ${done} of ${listed} folders done`] : [];

const modeLine = (mode: Option.Option<string>) =>
	`Mode: ${Option.getOrElse(mode, () => "unknown")}`;

const errorLine = (error: Option.Option<string>) =>
	`Last error: ${Option.getOrElse(error, () => "none")}`;

/** The line that names an account: its alias, with who signed in to it once mx knows. */
const accountLine = ({ address, alias }: Account) =>
	address === undefined ? `Account ${alias}` : `Account ${alias}: ${address}`;

/** An account's sign-in, client id and tenant. */
const signInLines = ({
	account: { clientId, tenant },
	signIn,
}: AccountStatus) => [
	`Sign-in: ${signIn.line}`,
	`Client id: ${clientId}`,
	`Tenant: ${tenant}`,
];

/** What is wrong with mail that last synced at `lastSuccess` while mx sync reports `error`: out of date, and the error. */
const syncProblems = (
	lastSuccess: Option.Option<Temporal.Instant>,
	error: Option.Option<string>,
	now: Temporal.Instant
) => [
	isFresh(lastSuccess, now)
		? Option.none()
		: Option.some(`${synced(lastSuccess, now)}.`),
	Option.map(error, (message) => `mx sync reports an error: ${message}`),
];

/**
 * What `mx status` prints, one fact per line with the lines of each account, and the first problem, which makes it exit
 * non-zero: sync not running, mail out of date, its last error, or a secret store that cannot be read. While an
 * account's first sync runs, it says how far that has got. With several accounts, each account's lines say when its mail
 * last synced, its mode and its last error, and its problems name it.
 */
export const statusReport = ({
	accounts,
	heartbeat,
	now,
	version,
}: {
	readonly accounts: readonly AccountStatus[];
	readonly heartbeat: Option.Option<Heartbeat>;
	readonly now: Temporal.Instant;
	readonly version: string;
}) => {
	const alive = Option.exists(heartbeat, (beat) => isAlive(beat, now));
	const running = Option.match(heartbeat, {
		onNone: () => "not running, and it has never run",
		onSome: (beat) =>
			`${alive ? "running" : "not running"}, last heard from ${ago(beat.at, now)} ago`,
	});
	const versionLine = `Version: mx sync ${Option.match(heartbeat, { onNone: () => "unknown", onSome: (beat) => beat.version })}, this binary ${version}`;
	const notRunning = alive
		? Option.none()
		: Option.some("mx sync is not running.");
	const report = (
		lines: readonly string[],
		problems: readonly Option.Option<string>[]
	) => ({
		problem: Arr.head(Arr.getSomes(problems)),
		text: Arr.join(lines, "\n"),
	});
	if (accounts.length > 1) {
		const followed = Arr.map(accounts, (status) => ({
			error: Option.flatMap(status.sync, (sync) => sync.error),
			lastSuccess: Option.flatMap(status.sync, (sync) => sync.lastSuccess),
			mode: Option.map(status.sync, (sync) => sync.mode),
			status,
		}));
		return report(
			[
				`mx sync: ${running}`,
				versionLine,
				...Arr.flatMap(followed, (each) => [
					accountLine(each.status.account),
					lastSyncLine(each.lastSuccess, now),
					...firstSyncLine(each.status),
					modeLine(each.mode),
					...signInLines(each.status),
					errorLine(each.error),
				]),
			],
			[
				notRunning,
				...Arr.flatMap(followed, (each) => [
					...Arr.map(
						syncProblems(each.lastSuccess, each.error, now),
						Option.map((problem) => `${each.status.account.alias}: ${problem}`)
					),
					each.status.signIn.problem,
				]),
			]
		);
	}
	const lastSuccess = Option.flatMap(heartbeat, (beat) => beat.lastSuccess);
	const error = Option.flatMap(heartbeat, (beat) => beat.error);
	return report(
		[
			`mx sync: ${running}`,
			lastSyncLine(lastSuccess, now),
			...Arr.flatMap(accounts, firstSyncLine),
			modeLine(Option.map(heartbeat, (beat) => beat.mode)),
			versionLine,
			...(Arr.isReadonlyArrayNonEmpty(accounts)
				? Arr.flatMap(accounts, (status) => [
						accountLine(status.account),
						...signInLines(status),
					])
				: ["Accounts: none. Run mx login."]),
			errorLine(error),
		],
		[
			notRunning,
			...syncProblems(lastSuccess, error, now),
			...Arr.map(accounts, ({ signIn }) => signIn.problem),
		]
	);
};
