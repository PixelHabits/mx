import {
	Array as Arr,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Latch,
	Layer,
	Option,
	Queue,
	Ref,
	Schedule,
	Schema,
	SynchronizedRef,
} from "effect";
import { Hex } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import { type Account, AccountsFile } from "./auth/config.ts";
import {
	type CredentialFailed,
	LoginRequired,
	PushUnavailable,
} from "./errors.ts";
import type { Subscription } from "./graph/api.ts";
import type { Graph, GraphError } from "./graph/graph.ts";
import { policy } from "./http-policy.ts";
import { Mailboxes, mailbox } from "./mailboxes.ts";
import { Cloudflared } from "./push/cloudflared.ts";
import { beatInterval, signInExpired, signInExpiredFor } from "./status.ts";
import {
	type AccountSync,
	type Heartbeat,
	Store,
	type SyncMode,
} from "./store.ts";
import {
	aboutAccount,
	type Pass,
	reconcileSummary,
	type Skipped,
	type Sync,
	skippedLine,
	summary,
} from "./sync.ts";

/** How often every folder is polled while push notifications arrive. */
const healthyPollInterval = Duration.minutes(5);

/** How often every folder is polled while push is down. */
const fallbackPollInterval = Duration.seconds(60);

/**
 * How often mx sync checks the whole store against Graph, after the check that follows its first pass. Deltas and push
 * carry every change, so the check only bounds how long a change they miss stays wrong; it costs a listing request per
 * 1000 messages of each folder, and a read for each message it repairs.
 */
const reconcileInterval = Duration.days(1);

/**
 * How long mx sync waits after a check that failed before it checks again. A check fails once the HTTP policy has spent
 * its retries of a request, so Graph is out or throttling for longer than those take; an hour lets that pass without
 * adding load while it lasts, and costs at most 24 checks a day, each failing at its first request, while the passes
 * keep the store current.
 */
const reconcileRetryInterval = Duration.hours(1);

/** How long push waits after it went down before it tries again. */
const pushRetryInterval = Duration.minutes(10);

/** Graph keeps an Outlook message subscription for at most 10,080 minutes; mx asks for 3 days and renews daily. */
const subscriptionLifetime = Duration.days(3);
const renewalInterval = Duration.days(1);

/** How often the tunnel's public URL is probed while push is up. */
const tunnelCheckInterval = Duration.minutes(5);

/** How long a new quick tunnel may take to answer from the internet; it took about 30 seconds when measured. */
const reachableWait = Duration.seconds(90);
const reachableProbeSpacing = Duration.seconds(2);

/** Notifications that arrive this close together share one delta pass per folder. */
const notificationDebounce = Duration.seconds(1);

/** How long shutdown waits to delete this run's subscriptions. */
const shutdownWait = Duration.seconds(10);

const changeType = "created,updated,deleted";

/** The folders push watches, by Graph's well-known names. */
const watched = ["inbox", "sentitems"] as const;
type Watched = (typeof watched)[number];

/** The notification URL of every subscription an `mx sync` makes: a quick tunnel's `/graph`. */
const quickTunnelUrl = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/graph$/u;

/** Deletes the quick-tunnel subscriptions of the account `graph` signs in to, but those in `kept`. */
export const unsubscribeTunnels = Effect.fnUntraced(function* (
	graph: Graph["Service"],
	kept: ReadonlySet<string>
) {
	const stale = Arr.filter(
		yield* graph.subscriptions,
		(subscription: Subscription) =>
			quickTunnelUrl.test(subscription.notificationUrl) &&
			!kept.has(subscription.id)
	);
	yield* Effect.forEach(stale, ({ id }) => graph.unsubscribe(id), {
		discard: true,
	});
});

const Notification = Schema.Struct({
	clientState: Schema.optionalKey(Schema.NullOr(Schema.String)),
	lifecycleEvent: Schema.optionalKey(Schema.String),
	subscriptionId: Schema.String,
});
type Notification = typeof Notification.Type;

const decodeNotifications = Schema.decodeEffect(
	Schema.fromJsonString(Schema.Struct({ value: Schema.Array(Notification) }))
);

/**
 * The webhook Graph calls, `POST /graph` and nothing else. A `validationToken` is echoed as text, as Graph requires
 * within 10 seconds. Any other post is a batch of change or lifecycle notifications: those whose `clientState` is this
 * run's secret are queued, and the post is answered 202 at once, so Graph never counts the endpoint slow.
 */
const webhook =
	(clientState: string, queue: Queue.Enqueue<Notification>) =>
	(request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/graph") {
			return Promise.resolve(new Response(null, { status: 404 }));
		}
		const token = url.searchParams.get("validationToken");
		if (token !== null) {
			return Promise.resolve(
				new Response(token, { headers: { "content-type": "text/plain" } })
			);
		}
		return Effect.runPromise(
			Effect.promise(() => request.text()).pipe(
				Effect.flatMap(decodeNotifications),
				Effect.map(({ value }) => {
					Queue.offerAllUnsafe(
						queue,
						Arr.filter(value, (entry) => entry.clientState === clientState)
					);
					return new Response(null, { status: 202 });
				}),
				Effect.orElseSucceed(() => new Response(null, { status: 400 }))
			)
		);
	};

const randomHex = (bytes: number) =>
	Hex.encode(crypto.getRandomValues(new Uint8Array(bytes)));

/** How mx sync follows an account in this run: as the store keeps it, and when its last error happened. */
interface Status extends AccountSync {
	/** When the last error happened, on this run's clock; 0 for an error an earlier mx sync recorded. */
	readonly errorAt: number;
}

/** An account mx sync follows: its mailbox, and how this run's passes, checks and push go for it. */
interface Followed {
	/** A line mx sync logs about the account. */
	readonly about: (text: string) => string;
	readonly account: Account;
	/** What mx sync records when Microsoft refuses the account's saved sign-in or it has none. */
	readonly expired: string;
	/** Opens once a pass of the account has succeeded, which its first check against Graph waits for. */
	readonly firstPass: Latch.Latch;
	readonly graph: Graph["Service"];
	readonly lastPoll: Ref.Ref<number>;
	/** The notifications of the account's subscriptions, which its push takes in batches. */
	readonly notifications: Queue.Queue<Notification>;
	readonly status: SynchronizedRef.SynchronizedRef<Status>;
	/** Fails once the account stops: its sign-in expired or the secret store failed. */
	readonly stopped: Deferred.Deferred<never, LoginRequired | CredentialFailed>;
	/** The account's subscription ids on this run's current tunnel by folder, which renewals keep and shutdown deletes. */
	readonly subscribed: Ref.Ref<ReadonlyMap<Watched, string>>;
	readonly sync: Sync["Service"];
}

/** The earlier of two instants. */
const earlier = (a: Temporal.Instant, b: Temporal.Instant) =>
	Temporal.Instant.compare(a, b) <= 0 ? a : b;

/**
 * What the heartbeat says of the accounts, for an mx mcp of an earlier release that reads it alone: push while any
 * account has push, the oldest of their last successes, and the newest of their errors, named by `about`.
 */
const summed = (
	statuses: readonly (readonly [Followed, Status])[]
): Pick<Heartbeat, "error" | "lastSuccess" | "mode"> => {
	const modes = new Set(Arr.map(statuses, ([, status]) => status.mode));
	const mode = Option.getOrElse(
		Arr.findFirst(["push", "poll"] as const, (each) => modes.has(each)),
		(): SyncMode => "starting"
	);
	const lastSuccess = Option.flatMap(
		Option.all(Arr.map(statuses, ([, status]) => status.lastSuccess)),
		Arr.match({
			onEmpty: () => Option.none<Temporal.Instant>(),
			onNonEmpty: ([first, ...rest]) =>
				Option.some(Arr.reduce(rest, first, earlier)),
		})
	);
	const error = Arr.reduce(
		statuses,
		Option.none<{ readonly at: number; readonly message: string }>(),
		(newest, [followed, status]) =>
			Option.match(status.error, {
				onNone: () => newest,
				onSome: (message) =>
					Option.exists(newest, ({ at }) => at >= status.errorAt)
						? newest
						: Option.some({
								at: status.errorAt,
								message: followed.about(message),
							}),
			})
	);
	return {
		error: Option.map(error, ({ message }) => message),
		lastSuccess,
		mode,
	};
};

/**
 * `mx sync` as a service: every account that config.json names, in one process, through one cloudflared quick tunnel to
 * a local webhook. Each account has two Graph subscriptions, on Inbox and Sent Items, and each notification runs a delta
 * pass of its folder in its own account. Every folder of each account is also polled, every 5 minutes while the account
 * has push and every 60 seconds while it does not, and push tries again every 10 minutes. After an account's first pass
 * and then once a day, mx sync checks its part of the store against Graph and repairs what the deltas missed. A folder
 * or a message Graph refuses is skipped and named in the account's status, and Graph's other failures wait for the next
 * pass or check, so only a failure the user must fix stops an account, and the others go on. The store keeps each
 * account's status, written as mx sync starts, after every pass and check of it and on every change of its mode, and
 * the heartbeat, which mx sync writes every minute and with each status, and which sums up the accounts'.
 */
export class Watch extends Context.Service<
	Watch,
	{
		/**
		 * Runs until every account has stopped. An account stops when its sign-in expires or the secret store fails, and
		 * records that failure first; ending it deletes this run's subscriptions.
		 */
		readonly run: Effect.Effect<never, LoginRequired | CredentialFailed>;
	}
>()("mx/watch") {
	static readonly layerNoDeps = Layer.effect(
		Watch,
		Effect.gen(function* () {
			const cloudflared = yield* Cloudflared;
			const store = yield* Store;
			const http = policy(yield* HttpClient.HttpClient);
			/** Graph sends it back on every notification; at most 128 characters. */
			const clientState = randomHex(32);
			const accounts = yield* (yield* AccountsFile).read;
			const several = accounts.length > 1;
			// An mx sync that ran on while mx logout removed an account can file some of its mail again before the logout
			// restarts it.
			if (Arr.isReadonlyArrayNonEmpty(accounts)) {
				yield* store.keepAccounts(Arr.map(accounts, ({ id }) => id));
			}
			const saved = yield* store.accountSyncs;
			const following = yield* Effect.forEach(accounts, (account) =>
				Effect.gen(function* () {
					const { graph, sync } = yield* mailbox(account.id);
					/** How the account's passes went, carried over from what an earlier mx sync wrote. */
					const before = Option.fromUndefinedOr(saved.get(account.id));
					return {
						about: aboutAccount(several, account.alias),
						account,
						expired: several ? signInExpiredFor(account.alias) : signInExpired,
						firstPass: yield* Latch.make(),
						graph,
						lastPoll: yield* Ref.make(0),
						notifications: yield* Queue.unbounded<Notification>(),
						status: yield* SynchronizedRef.make<Status>({
							error: Option.flatMap(before, ({ error }) => error),
							errorAt: 0,
							lastSuccess: Option.flatMap(
								before,
								({ lastSuccess }) => lastSuccess
							),
							mode: "starting",
						}),
						stopped: yield* Deferred.make<
							never,
							LoginRequired | CredentialFailed
						>(),
						subscribed: yield* Ref.make<ReadonlyMap<Watched, string>>(
							new Map()
						),
						sync,
					} satisfies Followed;
				})
			);

			const currentInstant = Effect.map(Clock.currentTimeMillis, (millis) =>
				Temporal.Instant.fromEpochMilliseconds(millis)
			);

			const beat = Effect.gen(function* () {
				const statuses = yield* Effect.forEach(following, (followed) =>
					Effect.map(
						SynchronizedRef.get(followed.status),
						(status) => [followed, status] as const
					)
				);
				yield* store.beat({
					at: yield* currentInstant,
					...summed(statuses),
					version: packageJson.version,
				});
			});

			/** Changes how mx sync follows the account, writes that and the heartbeat, and answers how it followed it before. */
			const record = (followed: Followed, change: (status: Status) => Status) =>
				SynchronizedRef.modifyEffect(followed.status, (before) => {
					const after = change(before);
					return Effect.as(store.saveAccountSync(followed.account.id, after), [
						before,
						after,
					] as const);
				}).pipe(Effect.tap(() => beat));

			const recordError = (followed: Followed, message: string) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					record(followed, (status) => ({
						...status,
						error: Option.some(message),
						errorAt: now,
					}))
				);

			/**
			 * Records how a pass or a check of the account went, with what it skipped, and answers whether it succeeded. A
			 * refusal or an outage that stops it is logged and waits for the next one.
			 */
			const recorded = (
				followed: Followed,
				work: Effect.Effect<readonly Skipped[], GraphError>
			) =>
				Effect.gen(function* () {
					const skipped = yield* work;
					const error = Arr.isReadonlyArrayNonEmpty(skipped)
						? Option.some(skippedLine(skipped))
						: Option.none<string>();
					if (Option.isSome(error)) {
						yield* Effect.logWarning(followed.about(error.value));
					}
					const now = yield* Clock.currentTimeMillis;
					yield* record(followed, (status) => ({
						...status,
						error,
						errorAt: now,
						lastSuccess: Option.some(
							Temporal.Instant.fromEpochMilliseconds(now)
						),
					}));
					return true;
				}).pipe(
					Effect.catchTag(["GraphRefused", "MicrosoftUnavailable"], (error) =>
						Effect.andThen(
							Effect.logWarning(followed.about(error.message)),
							recordError(followed, error.message)
						).pipe(Effect.as(false))
					)
				);

			/** A pass of the account that logs what it changed and records how it went. */
			const logged = (
				followed: Followed,
				pass: Effect.Effect<Pass, GraphError>
			) =>
				recorded(
					followed,
					pass.pipe(
						Effect.tap((done) =>
							done.saved + done.removed > 0
								? Effect.logInfo(followed.about(summary(done)))
								: Effect.void
						),
						Effect.tap(followed.firstPass.open),
						Effect.map((done) => done.skipped)
					)
				);

			const changeMode = (
				followed: Followed,
				next: "push" | "poll",
				line: string
			) =>
				Effect.flatMap(
					record(followed, (status) => ({ ...status, mode: next })),
					(before) =>
						before.mode === next
							? Effect.void
							: Effect.logInfo(followed.about(line))
				);

			const unavailable = (message: string) =>
				PushUnavailable.make({ message });

			/** Posts a validation token through the tunnel and checks that the webhook echoes it. */
			const probe = (url: string) => {
				const token = randomHex(16);
				return http.post(`${url}?validationToken=${token}`).pipe(
					Effect.flatMap(HttpClientResponse.filterStatusOk),
					Effect.flatMap((response) => response.text),
					Effect.filterOrFail(
						(text) => text === token,
						() => unavailable(`${url} did not echo its validation token.`)
					),
					Effect.mapError((error) =>
						error._tag === "PushUnavailable"
							? error
							: unavailable(`${url} did not answer: ${error.message}`)
					)
				);
			};

			const reachable = (url: string) =>
				probe(url).pipe(
					Effect.retry(Schedule.spaced(reachableProbeSpacing)),
					Effect.timeoutOrElse({
						duration: reachableWait,
						orElse: () =>
							unavailable(
								`The quick tunnel did not answer from the internet within ${Duration.format(reachableWait)}.`
							),
					})
				);

			/** Renews the account's subscription of the folder, or subscribes it through `url` when it has none or Graph lost it. */
			const keepSubscribed = Effect.fnUntraced(function* (
				followed: Followed,
				folder: Watched,
				url: string
			) {
				const expiration = Temporal.Instant.fromEpochMilliseconds(
					(yield* Clock.currentTimeMillis) +
						Duration.toMillis(subscriptionLifetime)
				);
				const existing = (yield* Ref.get(followed.subscribed)).get(folder);
				if (existing !== undefined) {
					const renewed = yield* followed.graph
						.renew(existing, expiration)
						.pipe(
							Effect.asSome,
							Effect.catchTag("GraphRefused", (refused) =>
								refused.status === 404
									? Effect.succeedNone
									: Effect.fail(refused)
							)
						);
					if (Option.isSome(renewed)) {
						return renewed.value;
					}
				}
				const created = yield* followed.graph.subscribe({
					changeType,
					clientState,
					expiration,
					lifecycleNotificationUrl: url,
					notificationUrl: url,
					resource: `me/mailFolders('${folder}')/messages`,
				});
				yield* Ref.update(followed.subscribed, (current) =>
					new Map(current).set(folder, created.id)
				);
				return created;
			});

			/**
			 * Deletes the account's quick-tunnel subscriptions that are not its current ones: those an earlier `mx sync` left
			 * behind, and this run's on a tunnel that ended.
			 */
			const clearStale = (followed: Followed) =>
				Effect.flatMap(Ref.get(followed.subscribed), (ours) =>
					unsubscribeTunnels(followed.graph, new Set(ours.values()))
				);

			/**
			 * Handles the account's notifications in batches: each changed folder gets one delta pass, `missed` gets one too,
			 * and `reauthorizationRequired` reauthorizes. Graph removing a subscription ends the account's push, so it
			 * subscribes again.
			 */
			const consume = (
				followed: Followed,
				folderIds: ReadonlyMap<Watched, string>
			) =>
				Effect.gen(function* () {
					const first = yield* Queue.takeAll(followed.notifications);
					yield* Effect.sleep(notificationDebounce);
					const batch = [
						...first,
						...(yield* Queue.clear(followed.notifications)),
					];
					const bySubscription = new Map(
						Arr.map(
							[...(yield* Ref.get(followed.subscribed))],
							([folder, id]) => [id, folderIds.get(folder)]
						)
					);
					const changed = new Set<string>();
					for (const { lifecycleEvent, subscriptionId } of batch) {
						const folderId = bySubscription.get(subscriptionId);
						if (folderId === undefined) {
							continue;
						}
						if (lifecycleEvent === "subscriptionRemoved") {
							return yield* unavailable("Graph removed a subscription.");
						}
						if (lifecycleEvent === "reauthorizationRequired") {
							yield* followed.graph.reauthorize(subscriptionId);
						} else {
							changed.add(folderId);
						}
					}
					yield* Effect.forEach(
						changed,
						(folderId) => logged(followed, followed.sync.folderPass(folderId)),
						{ discard: true }
					);
				}).pipe(Effect.forever);

			const renew = (followed: Followed, url: string) =>
				Effect.sleep(renewalInterval).pipe(
					Effect.andThen(
						Effect.forEach(watched, (folder) =>
							keepSubscribed(followed, folder, url)
						)
					),
					Effect.forever
				);

			/** The account's push through the tunnel at `url`: subscribed and in step until anything of its own fails. */
			const joined = (followed: Followed, url: string) =>
				Effect.gen(function* () {
					// Graph cannot move a subscription's lifecycle notifications to a new URL, so each start subscribes afresh.
					yield* Ref.set(followed.subscribed, new Map());
					yield* clearStale(followed);
					yield* Effect.forEach(watched, (folder) =>
						keepSubscribed(followed, folder, url)
					);
					const folderIds = new Map(
						yield* Effect.forEach(watched, (folder) =>
							Effect.map(
								followed.graph.folder(folder),
								({ id }) => [folder, id] as const
							)
						)
					);
					yield* logged(followed, followed.sync.pass);
					yield* changeMode(
						followed,
						"push",
						`Push is up through ${url}; polling every ${Duration.format(healthyPollInterval)}.`
					);
					return yield* Effect.raceFirst(
						renew(followed, url),
						consume(followed, folderIds)
					);
				});

			/**
			 * The account's push for as long as the tunnel at `url` lives. A failure of the account's own puts it on polling:
			 * it subscribes again at once when it had push, and after a wait when it never got it.
			 */
			const pushThrough = (followed: Followed, url: string) =>
				joined(followed, url).pipe(
					Effect.catchTag(
						["PushUnavailable", "GraphRefused", "MicrosoftUnavailable"],
						(failure) =>
							Effect.gen(function* () {
								if (
									(yield* SynchronizedRef.get(followed.status)).mode === "push"
								) {
									yield* changeMode(
										followed,
										"poll",
										`Push is down: ${failure.message} Polling every ${Duration.format(fallbackPollInterval)} while mx subscribes again.`
									);
									return;
								}
								yield* changeMode(
									followed,
									"poll",
									`Push is unavailable: ${failure.message} Polling every ${Duration.format(fallbackPollInterval)}; push tries again every ${Duration.format(pushRetryInterval)}.`
								);
								yield* Effect.sleep(pushRetryInterval);
							})
					),
					Effect.forever
				);

			/** Runs `work` of the account until the account stops, unless it has; a failure of `work` stops it. */
			const untilStopped = (
				followed: Followed,
				work: Effect.Effect<never, LoginRequired | CredentialFailed>
			) =>
				Effect.flatMap(Deferred.isDone(followed.stopped), (done) =>
					done
						? Effect.void
						: work.pipe(
								Effect.raceFirst(Deferred.await(followed.stopped)),
								Effect.catch((error) => Deferred.fail(followed.stopped, error)),
								Effect.asVoid
							)
				);

			/** Hands each notification to the account whose subscription it names; one that no account holds is dropped. */
			const dispatch = (queue: Queue.Dequeue<Notification>) =>
				Effect.gen(function* () {
					const batch = yield* Queue.takeAll(queue);
					const owners = yield* Effect.forEach(following, (followed) =>
						Effect.map(
							Ref.get(followed.subscribed),
							(current) => [followed, new Set(current.values())] as const
						)
					);
					for (const notification of batch) {
						const owner = Arr.findFirst(owners, ([, ids]) =>
							ids.has(notification.subscriptionId)
						);
						if (Option.isSome(owner)) {
							yield* Queue.offer(owner.value[0].notifications, notification);
						}
					}
				}).pipe(Effect.forever);

			const checkTunnel = (url: string) =>
				Effect.sleep(tunnelCheckInterval).pipe(
					Effect.andThen(probe(url)),
					Effect.forever
				);

			/** One tunnel's life: up, with each account's push through it, until the tunnel fails. */
			const session = Effect.gen(function* () {
				const queue = yield* Queue.unbounded<Notification>();
				const server = yield* Effect.acquireRelease(
					Effect.sync(() =>
						Bun.serve({
							fetch: webhook(clientState, queue),
							hostname: "127.0.0.1",
							port: 0,
						})
					),
					(served) => Effect.promise(() => served.stop(true))
				);
				if (server.port === undefined) {
					return yield* Effect.die("Bun.serve listened on no TCP port.");
				}
				const tunnel = yield* cloudflared.open(server.port);
				const url = `https://${tunnel.host}/graph`;
				yield* reachable(url).pipe(Effect.raceFirst(tunnel.exited));
				return yield* Effect.raceAllFirst([
					tunnel.exited,
					checkTunnel(url),
					dispatch(queue),
					Effect.forEach(
						following,
						(followed) => untilStopped(followed, pushThrough(followed, url)),
						{ concurrency: "unbounded", discard: true }
					).pipe(Effect.andThen(Effect.never)),
				]);
			}).pipe(Effect.scoped);

			/** Deletes this run's subscriptions of every account, as far as Graph answers in time. */
			const unsubscribeAll = Effect.forEach(
				following,
				(followed) =>
					Effect.flatMap(Ref.get(followed.subscribed), (current) =>
						Effect.forEach(
							current.values(),
							(id) => Effect.ignore(followed.graph.unsubscribe(id)),
							{ discard: true }
						)
					),
				{ concurrency: "unbounded", discard: true }
			).pipe(Effect.timeoutOption(shutdownWait), Effect.asVoid);

			/**
			 * A tunnel that ends after an account had push through it is replaced at once; a start that fails waits before the
			 * next one. Either puts every account that goes on on polling.
			 */
			const push = Effect.gen(function* () {
				const failure = yield* Effect.flip(session);
				const going = yield* Effect.filter(following, (followed) =>
					Effect.map(Deferred.isDone(followed.stopped), (done) => !done)
				);
				const hadPush = Arr.some(
					yield* Effect.forEach(going, (followed) =>
						SynchronizedRef.get(followed.status)
					),
					({ mode }) => mode === "push"
				);
				const line = hadPush
					? `Push is down: ${failure.message} Polling every ${Duration.format(fallbackPollInterval)} while a new tunnel starts.`
					: `Push is unavailable: ${failure.message} Polling every ${Duration.format(fallbackPollInterval)}; push tries again every ${Duration.format(pushRetryInterval)}.`;
				yield* Effect.forEach(
					going,
					(followed) => changeMode(followed, "poll", line),
					{ discard: true }
				);
				if (!hadPush) {
					yield* Effect.sleep(pushRetryInterval);
				}
			}).pipe(Effect.forever, Effect.ensuring(unsubscribeAll));

			/** A pass of the account every 60 seconds while it has no push, and every 5 minutes while it has. */
			const poll = (followed: Followed) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					const due =
						(yield* SynchronizedRef.get(followed.status)).mode !== "push" ||
						now - (yield* Ref.get(followed.lastPoll)) >=
							Duration.toMillis(healthyPollInterval);
					if (!due) {
						return;
					}
					yield* Ref.set(followed.lastPoll, now);
					yield* logged(followed, followed.sync.pass);
				}).pipe(Effect.repeat(Schedule.spaced(fallbackPollInterval)));

			/**
			 * The account's check against Graph, once its first pass succeeded, then every day, or an hour after a check that
			 * failed; it logs what it repaired.
			 */
			const reconcile = (followed: Followed) =>
				followed.firstPass.await.pipe(
					Effect.andThen(
						recorded(
							followed,
							Effect.tap(followed.sync.reconcile, (done) =>
								Effect.logInfo(followed.about(reconcileSummary(done)))
							).pipe(Effect.map((done) => done.skipped))
						).pipe(
							Effect.flatMap((succeeded) =>
								Effect.sleep(
									succeeded ? reconcileInterval : reconcileRetryInterval
								)
							),
							Effect.forever
						)
					)
				);

			/**
			 * The account's polls and checks until it stops, through them or through its push. It records why, and logs it
			 * when mx sync goes on with other accounts.
			 */
			const life = (followed: Followed) =>
				Effect.raceAllFirst([
					poll(followed),
					reconcile(followed),
					Deferred.await(followed.stopped),
				]).pipe(
					Effect.andThen(Effect.never),
					Effect.tapError((error) =>
						Effect.gen(function* () {
							yield* Deferred.fail(followed.stopped, error);
							const message =
								error._tag === "LoginRequired"
									? followed.expired
									: error.message;
							if (several) {
								yield* Effect.logError(followed.about(message));
							}
							yield* recordError(followed, message);
						})
					)
				);

			/** Fails with the first account's failure once every account has stopped, and at once when there is none. */
			const lives = Effect.forEach(
				following,
				(followed) => Effect.flip(life(followed)),
				{ concurrency: "unbounded" }
			).pipe(
				Effect.flatMap(
					Arr.match({
						onEmpty: () =>
							Effect.fail(LoginRequired.make({ reason: "mx has no account." })),
						onNonEmpty: ([first]) => Effect.fail(first),
					})
				)
			);

			/** The heartbeat from start to stop, so mx sync looks alive however long a pass takes. */
			const heartbeat = beat.pipe(Effect.repeat(Schedule.spaced(beatInterval)));

			/** Each account's status as this run starts, so the store holds no mode that an earlier mx sync left. */
			const started = Effect.forEach(
				following,
				(followed) =>
					Effect.flatMap(SynchronizedRef.get(followed.status), (status) =>
						store.saveAccountSync(followed.account.id, status)
					),
				{ discard: true }
			);

			const run = started.pipe(
				Effect.andThen(Effect.raceAllFirst([heartbeat, push, lives])),
				Effect.andThen(Effect.never),
				Effect.withSpan("Watch.run")
			);

			return Watch.of({ run });
		})
	);

	static readonly layer = Watch.layerNoDeps.pipe(
		Layer.provide(
			Layer.mergeAll(
				Mailboxes.layer,
				AccountsFile.layer,
				Cloudflared.layer,
				Store.layer
			)
		)
	);
}
