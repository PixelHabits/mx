import { Array as Arr, pipe, String as Str } from "effect";

type Json = Record<string, unknown>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

const graphError = (status: number, code: string, message: string) =>
	json({ error: { code, message } }, status);

/**
 * Cloudflare's side of the quick tunnels the fake cloudflared opens: each public host forwards to a loopback port, and
 * each cloudflared metrics server names its host at `/quicktunnel`.
 */
export class FakeTunnels {
	/** Public host to the local port its tunnel forwards to. */
	readonly hosts = new Map<string, number>();
	/** `127.0.0.1:<port>` of a metrics server to the host it names. */
	readonly metrics = new Map<string, string>();

	answers(url: URL) {
		return this.hosts.has(url.hostname) || this.metrics.has(url.host);
	}

	/** A request to a tunnel host goes through to the local server; one to a metrics server answers its host. */
	forward(request: Request, url: URL, body: Uint8Array): Promise<Response> {
		const host = this.metrics.get(url.host);
		if (host !== undefined) {
			return Promise.resolve(
				url.pathname === "/quicktunnel"
					? json({ hostname: host })
					: new Response(null, { status: 404 })
			);
		}
		return this.fetch(request.method, url, body.length === 0 ? null : body);
	}

	/** Sends a request across the internet to `url`, answering 502 when no tunnel serves its host, as Cloudflare does. */
	fetch(method: string, url: URL, body: string | Uint8Array | null) {
		const port = this.hosts.get(url.hostname);
		if (port === undefined) {
			return Promise.resolve(new Response(null, { status: 502 }));
		}
		return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
			body,
			headers: { "content-type": "text/plain" },
			method,
		}).catch(() => new Response(null, { status: 502 }));
	}
}

export interface FakeSubscription {
	readonly changeType: string;
	readonly clientState: string;
	expirationDateTime: string;
	readonly id: string;
	readonly lifecycleNotificationUrl: string;
	notificationUrl: string;
	readonly resource: string;
}

/**
 * Graph's subscriptions for the user of one mailbox. Creating one validates both URLs as Graph does: a POST with a
 * `validationToken` that must come back as text within the request. Every id starts with the mailbox's `prefix`, so no
 * id is in two mailboxes.
 */
export class FakeSubscriptions {
	readonly byId = new Map<string, FakeSubscription>();
	readonly validated: string[] = [];
	readonly reauthorized: string[] = [];
	/** Each notification post and the status the webhook answered. */
	readonly delivered: { readonly status: number; readonly url: string }[] = [];
	private next = 0;

	private readonly tunnels: FakeTunnels;
	private readonly prefix: string;

	constructor(tunnels: FakeTunnels, prefix: string) {
		this.tunnels = tunnels;
		this.prefix = prefix;
	}

	/** Adds a subscription another run left behind. */
	seed(subscription: Omit<FakeSubscription, "id">) {
		this.next += 1;
		const id = `${this.prefix}subscription-stale-${this.next}`;
		this.byId.set(id, { ...subscription, id });
		return id;
	}

	answer(
		method: string,
		id: string | undefined,
		action: string | undefined,
		body: Json
	): Promise<Response> {
		if (id === undefined) {
			return method === "POST"
				? this.create(body)
				: Promise.resolve(
						json({
							value: Arr.map(
								[...this.byId.values()],
								({ clientState: _, ...listed }) => listed
							),
						})
					);
		}
		const subscription = this.byId.get(id);
		if (subscription === undefined) {
			return Promise.resolve(
				graphError(404, "ResourceNotFound", "The object was not found.")
			);
		}
		if (method === "DELETE") {
			this.byId.delete(subscription.id);
			return Promise.resolve(new Response(null, { status: 204 }));
		}
		if (action === "reauthorize") {
			this.reauthorized.push(subscription.id);
			return Promise.resolve(new Response(null, { status: 204 }));
		}
		if (typeof body.notificationUrl === "string") {
			subscription.notificationUrl = body.notificationUrl;
		}
		if (typeof body.expirationDateTime === "string") {
			subscription.expirationDateTime = body.expirationDateTime;
		}
		return Promise.resolve(json(subscription));
	}

	/** Posts a change notification for each subscription on `folder`, as Graph does when a message arrives there. */
	async notify(folder: string, messageId: string, clientState?: string) {
		await Promise.all(
			Arr.map(this.on(folder), (subscription) =>
				this.post(subscription.notificationUrl, {
					changeType: "created",
					clientState: clientState ?? subscription.clientState,
					resource: subscription.resource,
					resourceData: {
						"@odata.type": "#Microsoft.Graph.Message",
						id: messageId,
					},
					subscriptionId: subscription.id,
				})
			)
		);
	}

	/** Posts a lifecycle notification for each subscription on `folder`. */
	async lifecycle(folder: string, lifecycleEvent: string) {
		await Promise.all(
			Arr.map(this.on(folder), (subscription) =>
				this.post(subscription.lifecycleNotificationUrl, {
					clientState: subscription.clientState,
					lifecycleEvent,
					subscriptionId: subscription.id,
				})
			)
		);
	}

	on(folder: string) {
		return Arr.filter(
			[...this.byId.values()],
			(subscription) =>
				subscription.resource === `me/mailFolders('${folder}')/messages`
		);
	}

	private async post(url: string, notification: Json) {
		const response = await this.tunnels.fetch(
			"POST",
			new URL(url),
			JSON.stringify({ value: [notification] })
		);
		this.delivered.push({ status: response.status, url });
	}

	private async validate(url: string) {
		const token = `synthetic validation ${crypto.randomUUID()}`;
		const target = new URL(url);
		target.searchParams.set("validationToken", token);
		const response = await this.tunnels.fetch("POST", target, null);
		const valid =
			response.status === 200 &&
			pipe(
				response.headers.get("content-type") ?? "",
				Str.startsWith("text/plain")
			) &&
			(await response.text()) === token;
		if (valid) {
			this.validated.push(url);
		}
		return valid;
	}

	private async create(body: Json) {
		const notificationUrl = String(body.notificationUrl);
		const lifecycleNotificationUrl = String(body.lifecycleNotificationUrl);
		if (
			!(
				(await this.validate(notificationUrl)) &&
				(await this.validate(lifecycleNotificationUrl))
			)
		) {
			return graphError(
				400,
				"ValidationError",
				"Subscription validation request failed."
			);
		}
		this.next += 1;
		const subscription: FakeSubscription = {
			changeType: String(body.changeType),
			clientState: String(body.clientState),
			expirationDateTime: String(body.expirationDateTime),
			id: `${this.prefix}subscription-${this.next}`,
			lifecycleNotificationUrl,
			notificationUrl,
			resource: String(body.resource),
		};
		this.byId.set(subscription.id, subscription);
		return json(subscription, 201);
	}
}
