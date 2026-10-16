import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Queue,
	Ref,
	Schedule,
	Schema,
} from "effect";
import { Hex } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import { PushUnavailable } from "./errors.ts";
import type { Subscription } from "./graph/api.ts";
import { Graph, type GraphError } from "./graph/graph.ts";
import { policy } from "./http-policy.ts";
import { Cloudflared } from "./push/cloudflared.ts";
import { type Pass, Sync, summary } from "./sync.ts";

/** How often every folder is polled while push notifications arrive. */
const healthyPollInterval = Duration.minutes(5);

/** How often every folder is polled while push is down. */
const fallbackPollInterval = Duration.seconds(60);

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

/** A pass that logs what it changed; an outage waits for the next pass. */
const logged = (pass: Effect.Effect<Pass, GraphError>) =>
	pass.pipe(
		Effect.tap((done) =>
			done.saved + done.removed > 0
				? Effect.logInfo(summary(done))
				: Effect.void
		),
		Effect.catchTag("MicrosoftUnavailable", (error) =>
			Effect.logWarning(error.message)
		)
	);

/**
 * `mx sync` as a service: Graph push notifications first, polling as the fallback. Push runs a cloudflared quick tunnel
 * to a local webhook and two Graph subscriptions, on Inbox and Sent Items; each notification runs a delta pass for its
 * folder. Every folder is also polled, every 5 minutes while push is up and every 60 seconds while it is down, and push
 * tries again every 10 minutes.
 */
export class Watch extends Context.Service<
	Watch,
	{
		/** Runs until a pass fails with anything but an outage; ending it deletes this run's subscriptions. */
		readonly run: Effect.Effect<never, GraphError>;
	}
>()("mx/watch") {
	static readonly layerNoDeps = Layer.effect(
		Watch,
		Effect.gen(function* () {
			const graph = yield* Graph;
			const sync = yield* Sync;
			const cloudflared = yield* Cloudflared;
			const http = policy(yield* HttpClient.HttpClient);
			/** Graph sends it back on every notification; at most 128 characters. */
			const clientState = randomHex(32);
			/** The subscription ids of this run's current tunnel by folder, which renewals keep and shutdown deletes. */
			const subscribed = yield* Ref.make(new Map<Watched, string>());
			const mode = yield* Ref.make<"starting" | "up" | "down">("starting");
			const lastPoll = yield* Ref.make(0);

			const changeMode = (next: "up" | "down", line: string) =>
				Effect.flatMap(Ref.getAndSet(mode, next), (previous) =>
					previous === next ? Effect.void : Effect.logInfo(line)
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

			/** Renews the folder's subscription, or subscribes it through `url` when the tunnel has none or Graph lost it. */
			const keepSubscribed = Effect.fnUntraced(function* (
				folder: Watched,
				url: string
			) {
				const expiration = Temporal.Instant.fromEpochMilliseconds(
					(yield* Clock.currentTimeMillis) +
						Duration.toMillis(subscriptionLifetime)
				);
				const existing = (yield* Ref.get(subscribed)).get(folder);
				if (existing !== undefined) {
					const renewed = yield* graph.renew(existing, expiration).pipe(
						Effect.asSome,
						Effect.catchTag("GraphRefused", (refused) =>
							refused.status === 404 ? Effect.succeedNone : Effect.fail(refused)
						)
					);
					if (Option.isSome(renewed)) {
						return renewed.value;
					}
				}
				const created = yield* graph.subscribe({
					changeType,
					clientState,
					expiration,
					lifecycleNotificationUrl: url,
					notificationUrl: url,
					resource: `me/mailFolders('${folder}')/messages`,
				});
				yield* Ref.update(subscribed, (current) =>
					new Map(current).set(folder, created.id)
				);
				return created;
			});

			/**
			 * Deletes the quick-tunnel subscriptions that are not the current tunnel's: those an earlier `mx sync` left behind,
			 * and this run's on a tunnel that ended.
			 */
			const clearStale = Effect.gen(function* () {
				const ours = new Set((yield* Ref.get(subscribed)).values());
				const stale = Arr.filter(
					yield* graph.subscriptions,
					(subscription: Subscription) =>
						quickTunnelUrl.test(subscription.notificationUrl) &&
						!ours.has(subscription.id)
				);
				yield* Effect.forEach(stale, ({ id }) => graph.unsubscribe(id), {
					discard: true,
				});
			});

			/**
			 * Handles notifications in batches: each changed folder gets one delta pass, `missed` gets one too, and
			 * `reauthorizationRequired` reauthorizes. Graph removing a subscription ends push, so the next start subscribes again.
			 */
			const consume = (
				queue: Queue.Dequeue<Notification>,
				folderIds: ReadonlyMap<Watched, string>
			) =>
				Effect.gen(function* () {
					const first = yield* Queue.takeAll(queue);
					yield* Effect.sleep(notificationDebounce);
					const batch = [...first, ...(yield* Queue.clear(queue))];
					const bySubscription = new Map(
						Arr.map([...(yield* Ref.get(subscribed))], ([folder, id]) => [
							id,
							folderIds.get(folder),
						])
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
							yield* graph.reauthorize(subscriptionId);
						} else {
							changed.add(folderId);
						}
					}
					yield* Effect.forEach(
						changed,
						(folderId) => logged(sync.folderPass(folderId)),
						{ discard: true }
					);
				}).pipe(Effect.forever);

			const renew = (url: string) =>
				Effect.sleep(renewalInterval).pipe(
					Effect.andThen(
						Effect.forEach(watched, (folder) => keepSubscribed(folder, url))
					),
					Effect.forever
				);

			const checkTunnel = (url: string) =>
				Effect.sleep(tunnelCheckInterval).pipe(
					Effect.andThen(probe(url)),
					Effect.forever
				);

			/** One tunnel's life: up, subscribed and in step, until anything fails. */
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
				// Graph cannot move a subscription's lifecycle notifications to a new URL, so each tunnel subscribes afresh.
				yield* Ref.set(subscribed, new Map());
				yield* clearStale;
				yield* Effect.forEach(watched, (folder) => keepSubscribed(folder, url));
				const folderIds = new Map(
					yield* Effect.forEach(watched, (folder) =>
						Effect.map(graph.folder(folder), ({ id }) => [folder, id] as const)
					)
				);
				yield* logged(sync.pass);
				yield* changeMode(
					"up",
					`Push is up through ${url}; polling every ${Duration.format(healthyPollInterval)}.`
				);
				return yield* Effect.raceAllFirst([
					tunnel.exited,
					checkTunnel(url),
					renew(url),
					consume(queue, folderIds),
				]);
			}).pipe(Effect.scoped);

			/** Deletes this run's subscriptions, as far as Graph answers in time. */
			const unsubscribeAll = Effect.flatMap(Ref.get(subscribed), (current) =>
				Effect.forEach(current.values(), (id) =>
					Effect.ignore(graph.unsubscribe(id))
				)
			).pipe(Effect.timeoutOption(shutdownWait), Effect.asVoid);

			/** A tunnel that ends after it came up is replaced at once; a start that fails waits before the next one. */
			const push = Effect.gen(function* () {
				const failure = yield* Effect.flip(session);
				if ((yield* Ref.get(mode)) === "up") {
					yield* changeMode(
						"down",
						`Push is down: ${failure.message} Polling every ${Duration.format(fallbackPollInterval)} while a new tunnel starts.`
					);
					return;
				}
				yield* changeMode(
					"down",
					`Push is unavailable: ${failure.message} Polling every ${Duration.format(fallbackPollInterval)}; push tries again every ${Duration.format(pushRetryInterval)}.`
				);
				yield* Effect.sleep(pushRetryInterval);
			}).pipe(Effect.forever, Effect.ensuring(unsubscribeAll));

			/** A pass of every folder, every 60 seconds while push is down and every 5 minutes while it is up. */
			const poll = Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const due =
					(yield* Ref.get(mode)) !== "up" ||
					now - (yield* Ref.get(lastPoll)) >=
						Duration.toMillis(healthyPollInterval);
				if (!due) {
					return;
				}
				yield* Ref.set(lastPoll, now);
				yield* logged(sync.pass);
			}).pipe(Effect.repeat(Schedule.spaced(fallbackPollInterval)));

			const run = Effect.raceFirst(push, poll).pipe(
				Effect.andThen(Effect.never),
				Effect.withSpan("Watch.run")
			);

			return Watch.of({ run });
		})
	);

	static readonly layer = Watch.layerNoDeps.pipe(
		Layer.provide(Layer.mergeAll(Sync.layer, Graph.layer, Cloudflared.layer))
	);
}
