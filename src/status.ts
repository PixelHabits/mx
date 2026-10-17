import { Array as Arr, Duration, Option } from "effect";
import type { Heartbeat } from "./store.ts";
import { localTime } from "./temporal.ts";

/** How often mx sync writes its heartbeat while it runs, however long a pass takes. */
export const beatInterval = Duration.minutes(1);

/** A heartbeat older than three beats means mx sync stopped. */
const aliveWithin = Duration.times(beatInterval, 3);

/** Mail that last synced longer ago may be out of date, since mx sync polls every folder at least every 5 minutes. */
const staleAfter = Duration.minutes(15);

/** The last error mx sync records when Microsoft refuses the saved sign-in or there is none. */
export const signInExpired = "Sign-in expired. Run mx login.";

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
 * The line a read tool puts before its answer when the store may be out of date: the sign-in expired, mx sync never ran
 * or is not running, or mail last synced longer ago than `staleAfter`, with the last error when there is one. None while
 * sync runs and mail is fresh.
 */
export const syncWarning = (
	heartbeat: Option.Option<Heartbeat>,
	now: Temporal.Instant
): Option.Option<string> => {
	if (Option.isNone(heartbeat)) {
		return Option.some("⚠ mx sync has never run. Run mx status.");
	}
	const { error, lastSuccess } = heartbeat.value;
	if (Option.contains(error, signInExpired)) {
		return Option.some(`⚠ ${signInExpired}`);
	}
	const alive = isAlive(heartbeat.value, now);
	if (alive && isFresh(lastSuccess, now)) {
		return Option.none();
	}
	const lastError = Option.match(error, {
		onNone: () => "",
		onSome: (message) => ` Last error: ${message}`,
	});
	return Option.some(
		`⚠ ${synced(lastSuccess, now)}${alive ? "" : " and mx sync is not running"}.${lastError} Run mx status.`
	);
};

/**
 * What `mx status` prints, one fact per line, and the first problem, which makes it exit non-zero: sync not running,
 * mail out of date, its last error, or a secret store that cannot be read.
 */
export const statusReport = ({
	clientId,
	heartbeat,
	now,
	signIn,
	tenant,
	version,
}: {
	/** Whether a client id is set, by `mx login` or `MX_CLIENT_ID`. */
	readonly clientId: boolean;
	readonly heartbeat: Option.Option<Heartbeat>;
	readonly now: Temporal.Instant;
	/** The sign-in line, and the problem when the secret store could not be read. */
	readonly signIn: {
		readonly line: string;
		readonly problem: Option.Option<string>;
	};
	/** The tenant mx signs in at. */
	readonly tenant: string;
	readonly version: string;
}) => {
	const alive = Option.exists(heartbeat, (beat) => isAlive(beat, now));
	const running = Option.match(heartbeat, {
		onNone: () => "not running, and it has never run",
		onSome: (beat) =>
			`${alive ? "running" : "not running"}, last heard from ${ago(beat.at, now)} ago`,
	});
	const lastSuccess = Option.flatMap(heartbeat, (beat) => beat.lastSuccess);
	const error = Option.flatMap(heartbeat, (beat) => beat.error);
	const lines = [
		`mx sync: ${running}`,
		`Last sync: ${Option.match(lastSuccess, {
			onNone: () => "never",
			onSome: (at) => `${localTime(at)}, ${ago(at, now)} ago`,
		})}`,
		`Mode: ${Option.match(heartbeat, { onNone: () => "unknown", onSome: (beat) => beat.mode })}`,
		`Version: mx sync ${Option.match(heartbeat, { onNone: () => "unknown", onSome: (beat) => beat.version })}, this binary ${version}`,
		`Sign-in: ${signIn.line}`,
		`Client id: ${clientId ? "set" : "none. Run mx login."}`,
		`Tenant: ${tenant}`,
		`Last error: ${Option.getOrElse(error, () => "none")}`,
	];
	const problem = Arr.getSomes([
		alive ? Option.none() : Option.some("mx sync is not running."),
		isFresh(lastSuccess, now)
			? Option.none()
			: Option.some(`${synced(lastSuccess, now)}.`),
		Option.map(error, (message) => `mx sync reports an error: ${message}`),
		signIn.problem,
	]);
	return { problem: Arr.head(problem), text: Arr.join(lines, "\n") };
};
