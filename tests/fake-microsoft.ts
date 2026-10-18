import { Array as Arr, Duration, Effect, Layer, Option } from "effect";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { FakeSubscriptions, FakeTunnels } from "./fake-push.ts";
import { type FakeReleases, isReleaseRequest } from "./fake-releases.ts";

/** Microsoft's sign-in host; its paths start with the tenant, as `/<tenant>/oauth2/v2.0/token`. */
export const loginHost = "login.microsoftonline.com";
export const userCode = "SYNTHCODE";
export const verificationUri = "https://login.example.test/device";
export const inlineImage = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
export const uploadOrigin = "https://upload.example.test";

const owner = { address: "sam@example.test", name: "Sam Example" };
const alice = { address: "alice@example.test", name: "Alice Example" };
const bob = { address: "bob@example.test", name: "Bob Example" };
const carol = { address: "carol@example.test", name: "Carol Example" };

/** The folder ids Graph answers for the well-known names mx sends. */
const wellKnown: Record<string, string> = {
	archive: "folder-archive",
	deleteditems: "folder-deleted",
	drafts: "folder-drafts",
	inbox: "folder-inbox",
	sentitems: "folder-sent",
};

interface Address {
	readonly address: string;
	readonly name: string;
}

interface FakeAttachment {
	readonly bytes: Uint8Array;
	readonly contentId: string | null;
	readonly id: string;
	readonly isInline: boolean;
	readonly name: string;
	readonly type: string;
}

interface FakeMessage {
	attachments: FakeAttachment[];
	bcc: Address[];
	body: string;
	categories: string[];
	cc: Address[];
	readonly conversationId: string;
	flag: "notFlagged" | "flagged" | "complete";
	readonly from: Address | null;
	readonly id: string;
	isDraft: boolean;
	isRead: boolean;
	parentFolderId: string;
	readonly received: string;
	readonly sent: string | null;
	subject: string;
	to: Address[];
	uniqueBody: string;
}

/** One request as it reached Microsoft. */
export interface Received {
	readonly authorization: string | null;
	readonly body: string;
	readonly method: string;
	readonly prefer: string | null;
	readonly url: URL;
}

type Json = Record<string, unknown>;

/** The key of a held request: what it reads, a folder's delta or the ids of its messages, and the folder. */
const heldKey = (folderId: string, ids: boolean) =>
	`${ids ? "ids" : "delta"} ${folderId}`;

const json = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {}
) => Response.json(body, { headers, status });

const graphError = (status: number, code: string, message: string) =>
	json({ error: { code, message } }, status);

const recipients = (list: readonly Address[]) =>
	Arr.map(list, (emailAddress) => ({ emailAddress }));

const parseRecipients = (value: unknown): Address[] =>
	Arr.isArray(value)
		? Arr.map(value, (entry) => {
				const { address } = (entry as { emailAddress: { address: string } })
					.emailAddress;
				return { address, name: address };
			})
		: [];

const content = (value: unknown) => (value as { content: string }).content;

/**
 * Microsoft's token endpoint and Graph for one synthetic mailbox, in memory. Each issued access and refresh token
 * carries a counter; a refresh token stays valid after it is used, as Entra's do. Graph answers only the newest access
 * token, honours `Prefer: outlook.body-content-type="text"` and keeps a change log per folder that its delta links
 * replay. Upload URLs refuse a bearer token, as Graph's do.
 */
export class FakeMicrosoft {
	readonly received: Received[] = [];
	readonly tunnels = new FakeTunnels();
	readonly subscriptions = new FakeSubscriptions(this.tunnels);
	/** Device-code polls still to answer `authorization_pending`. */
	pendingPolls = 1;
	/** When set, every refresh answers `invalid_grant`. */
	refuseRefresh = false;
	/** Graph requests still to answer 429. */
	throttle = 0;
	/** How many times each Graph request, by method and URL, answers 429 before Graph answers it. */
	throttleEach = 0;
	private readonly throttled = new Map<string, number>();
	/** Messages Graph deletes for good right after it answers their next read. */
	private readonly vanishing = new Set<string>();
	/** The seconds each 429 asks the client to wait in `Retry-After`. */
	retryAfter = 1;
	/** The status Graph answers every request with during an outage, such as 503; 0 while Graph is up. */
	outage = 0;
	/** How long Graph takes to answer each delta page, on the clock of the mx that asks. */
	deltaDelay = Duration.zero;
	/** The most delta requests Graph has had in flight at once. */
	mostDeltasAtOnce = 0;
	private deltasInFlight = 0;
	/** The folders whose delta rounds Graph ended with a delta link, in order. */
	readonly roundsEnded: string[] = [];
	/**
	 * The requests that wait until `release` lets them through, by what they read and the folder, and whether Graph
	 * answered them first.
	 */
	private readonly held = new Map<
		string,
		{ readonly answered: boolean; readonly gate: PromiseWithResolvers<void> }
	>();
	/**
	 * The messages whose next read by id waits until `releaseReads` lets it through. Graph reads the message as soon as
	 * it is asked, so the answer that arrives on release shows the message as it was then.
	 */
	private readonly heldReads = new Map<
		string,
		{ readonly gate: PromiseWithResolvers<void>; taken: boolean }
	>();
	readonly refreshTokens: string[] = [];
	private issued = 0;
	private accessToken = "";
	private readonly folders = new Map<
		string,
		{ readonly displayName: string; readonly parentFolderId: string }
	>([
		["folder-inbox", { displayName: "Inbox", parentFolderId: "folder-root" }],
		[
			"folder-projects",
			{ displayName: "Projects", parentFolderId: "folder-inbox" },
		],
		[
			"folder-sent",
			{ displayName: "Sent Items", parentFolderId: "folder-root" },
		],
		["folder-drafts", { displayName: "Drafts", parentFolderId: "folder-root" }],
		[
			"folder-deleted",
			{ displayName: "Deleted Items", parentFolderId: "folder-root" },
		],
		[
			"folder-archive",
			{ displayName: "Archive", parentFolderId: "folder-root" },
		],
	]);
	private readonly messages = new Map<string, FakeMessage>();
	/**
	 * Each change names the folder it touched, in order; a change Graph reports with only the properties that changed is
	 * `partial`.
	 */
	private readonly changes: {
		readonly folderId: string;
		readonly id: string;
		readonly partial?: true;
	}[] = [];
	/** The reads of a folder, its delta pages or the listing of its message ids, that Graph answers in a form mx cannot read. */
	private readonly unreadables = new Set<string>();
	private nextId = 100;
	private readonly uploads = new Map<
		string,
		{
			chunks: Uint8Array[];
			readonly messageId: string;
			readonly name: string;
			readonly size: number;
		}
	>();

	private readonly releases: FakeReleases;

	constructor(releases: FakeReleases) {
		this.releases = releases;
		this.add({
			attachments: [
				{
					bytes: inlineImage,
					contentId: "image001.png@01DC0000.00000000",
					id: "attachment-image",
					isInline: true,
					name: "image001.png",
					type: "image/png",
				},
				{
					bytes: new TextEncoder().encode("synthetic budget sheet"),
					contentId: null,
					id: "attachment-sheet",
					isInline: false,
					name: "budget.xls",
					type: "application/vnd.ms-excel",
				},
			],
			body: "Please review the quarterly budget.\r\n[cid:image001.png@01DC0000.00000000]\r\nThanks, Alice",
			conversationId: "conversation-budget",
			from: alice,
			id: "message-budget",
			parentFolderId: "folder-inbox",
			received: "2026-10-01T14:00:00Z",
			subject: "Quarterly budget",
			to: [owner],
		});
		this.add({
			body: "Looks fine. One question about travel.\r\n\r\nFrom: Alice Example\r\nPlease review the quarterly budget.",
			conversationId: "conversation-budget",
			from: owner,
			id: "message-reply",
			isRead: true,
			parentFolderId: "folder-sent",
			received: "2026-10-01T15:00:00Z",
			subject: "RE: Quarterly budget",
			to: [alice],
			uniqueBody: "Looks fine. One question about travel.",
		});
		this.add({
			body: "Travel stays under the cap.\r\n\r\nFrom: Sam Example\r\nLooks fine.",
			conversationId: "conversation-budget",
			from: alice,
			id: "message-answer",
			parentFolderId: "folder-inbox",
			received: "2026-10-01T16:00:00Z",
			subject: "RE: Quarterly budget",
			to: [owner],
			uniqueBody: "Travel stays under the cap.",
		});
		this.add({
			body: "Kickoff is on Thursday.",
			conversationId: "conversation-kickoff",
			from: bob,
			id: "message-kickoff",
			parentFolderId: "folder-projects",
			received: "2026-10-02T09:00:00Z",
			subject: "Kickoff notes",
			to: [owner],
		});
		this.add({
			body: "Lunch on Friday?",
			conversationId: "conversation-lunch",
			from: carol,
			id: "message-lunch",
			parentFolderId: "folder-inbox",
			received: "2026-10-03T11:00:00Z",
			subject: "Lunch plans",
			to: [owner],
		});
	}

	/** Microsoft as the HttpClient every request goes through. */
	readonly layer = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			HttpClientRequest.toWeb(request).pipe(
				Effect.flatMap((web) =>
					this.paced(
						web,
						Effect.promise(
							async (): Promise<Response> =>
								await this.answer(web, new Uint8Array(await web.arrayBuffer()))
						)
					)
				),
				Effect.orDie,
				Effect.map((response) => HttpClientResponse.fromWeb(request, response))
			)
		)
	);

	/**
	 * Makes the requests that read `folderId` wait until `release`: its delta pages, or with `ids` the listing of its
	 * message ids. With `answered`, Graph reads the folder as soon as it is asked, so the page that arrives on release
	 * shows the folder as it was then, as a page still on its way does.
	 */
	hold(folderId: string, { answered = false, ids = false } = {}) {
		this.held.set(heldKey(folderId, ids), {
			answered,
			gate: Promise.withResolvers<void>(),
		});
	}

	release(folderId: string, { ids = false } = {}) {
		const key = heldKey(folderId, ids);
		this.held.get(key)?.gate.resolve();
		this.held.delete(key);
	}

	/** Makes the next read of the message by its id wait until `releaseReads`, answered as Graph held it when asked. */
	holdRead(id: string) {
		this.heldReads.set(id, {
			gate: Promise.withResolvers<void>(),
			taken: false,
		});
	}

	releaseReads() {
		for (const { gate } of this.heldReads.values()) {
			gate.resolve();
		}
		this.heldReads.clear();
	}

	/**
	 * Answers a request that reads a folder's messages after `release` when it is held, and the next read of a message
	 * held by `holdRead` after `releaseReads`; a delta request also waits `deltaDelay` and counts in flight meanwhile.
	 */
	private paced<A>(request: Request, answer: Effect.Effect<A>) {
		const url = new URL(request.url);
		const [, , , collection, id = "", messages, delta] = decodeURIComponent(
			url.pathname
		).split("/");
		const read = this.heldReads.get(id);
		if (
			collection === "messages" &&
			messages === undefined &&
			request.method === "GET" &&
			read !== undefined &&
			!read.taken
		) {
			read.taken = true;
			return Effect.tap(answer, () => Effect.promise(() => read.gate.promise));
		}
		if (collection !== "mailFolders" || messages !== "messages") {
			return answer;
		}
		const ids = delta === undefined;
		const key = heldKey(id, ids);
		const gate = Effect.promise(
			() => this.held.get(key)?.gate.promise ?? Promise.resolve()
		);
		const waited = ids
			? gate
			: Effect.andThen(Effect.sleep(this.deltaDelay), gate);
		const held = () =>
			this.held.get(key)?.answered === true
				? Effect.tap(answer, () => waited)
				: Effect.andThen(waited, answer);
		if (ids) {
			return Effect.suspend(held);
		}
		const count = (step: number) =>
			Effect.sync(() => {
				this.deltasInFlight += step;
				this.mostDeltasAtOnce = Math.max(
					this.mostDeltasAtOnce,
					this.deltasInFlight
				);
			});
		return Effect.acquireUseRelease(count(1), held, () => count(-1));
	}

	/** Removes a message the way a permanent delete in Outlook does, so the next delta reports it removed. */
	purge(id: string) {
		const message = this.messages.get(id);
		if (message !== undefined) {
			this.messages.delete(id);
			this.changes.push({ folderId: message.parentFolderId, id });
		}
	}

	/** Moves a message the way Outlook does, so the next delta reports it removed from its folder and added to `folderId`. */
	move(id: string, folderId: string) {
		const message = this.messages.get(id);
		if (message !== undefined) {
			this.changes.push({ folderId: message.parentFolderId, id });
			message.parentFolderId = folderId;
			this.changes.push({ folderId, id });
		}
	}

	/** Marks a message read the way Outlook does, so the next delta reports only its `isRead` and `parentFolderId`. */
	readInOutlook(id: string) {
		const message = this.messages.get(id);
		if (message !== undefined) {
			message.isRead = true;
			this.changes.push({
				folderId: message.parentFolderId,
				id,
				partial: true,
			});
		}
	}

	/**
	 * Makes Graph answer the folder's delta pages, or with `ids` the listing of its message ids, with an entry that has no
	 * id, until `readable`.
	 */
	unreadable(folderId: string, { ids = false } = {}) {
		this.unreadables.add(heldKey(folderId, ids));
	}

	readable(folderId: string, { ids = false } = {}) {
		this.unreadables.delete(heldKey(folderId, ids));
	}

	/** The entries of a page of the folder, and the entry without an id while the read is `unreadable`. */
	private entries(folderId: string, ids: boolean, value: readonly unknown[]) {
		return this.unreadables.has(heldKey(folderId, ids))
			? [...value, { "@odata.type": "#microsoft.graph.message" }]
			: value;
	}

	/** Makes Graph answer the next read of the message by its id, then delete the message for good, as Outlook can. */
	vanishAfterRead(id: string) {
		this.vanishing.add(id);
	}

	/** Adds a mail folder below `parentFolderId`, as the user makes one in Outlook. */
	addFolder(id: string, displayName: string, parentFolderId: string) {
		this.folders.set(id, { displayName, parentFolderId });
	}

	/** Deletes a mail folder and the messages in it for good. */
	removeFolder(id: string) {
		this.folders.delete(id);
		for (const message of this.inFolder(id)) {
			this.messages.delete(message.id);
		}
	}

	/** A message from Bob arrives in Inbox, and Graph notifies Inbox's subscriptions. */
	receive(subject: string) {
		const added = this.add({
			body: `${subject}, in the body.`,
			conversationId: this.newId("conversation"),
			from: bob,
			id: this.newId("message"),
			parentFolderId: "folder-inbox",
			received: "2026-10-06T08:00:00Z",
			subject,
			to: [owner],
		});
		return this.subscriptions.notify("inbox", added.id);
	}

	/** A message to the user arrives in a folder without a notification, so the next pass brings it in. */
	deliver(
		message: Pick<
			FakeMessage,
			"body" | "conversationId" | "parentFolderId" | "received" | "subject"
		> & { readonly from: Address }
	) {
		return this.add({ ...message, id: this.newId("message"), to: [owner] });
	}

	/** The messages in a folder as Graph holds them now. */
	inFolder(folderId: string): readonly FakeMessage[] {
		return Arr.filter(
			[...this.messages.values()],
			(message) => message.parentFolderId === folderId
		);
	}

	graphRequests() {
		return Arr.filter(
			this.received,
			(request) => request.url.hostname === "graph.microsoft.com"
		);
	}

	private add(
		message: Partial<FakeMessage> &
			Pick<
				FakeMessage,
				| "body"
				| "conversationId"
				| "from"
				| "id"
				| "parentFolderId"
				| "received"
				| "subject"
				| "to"
			>
	) {
		const added: FakeMessage = {
			attachments: [],
			bcc: [],
			categories: [],
			cc: [],
			flag: "notFlagged",
			isDraft: false,
			isRead: false,
			sent: message.received,
			uniqueBody: message.body,
			...message,
		};
		this.messages.set(added.id, added);
		this.changes.push({ folderId: added.parentFolderId, id: added.id });
		return added;
	}

	/**
	 * Makes the changes `change` makes to messages leave no trace in any delta, as changes Graph's delta misses. No delta
	 * link is issued while it runs, so dropping the changes it logged moves no link.
	 */
	missedByDelta(change: () => void) {
		const logged = this.changes.length;
		change();
		this.changes.splice(logged);
	}

	private newId(prefix: string) {
		this.nextId += 1;
		return `${prefix}-${this.nextId}`;
	}

	private issue() {
		this.issued += 1;
		this.accessToken = `synthetic-access-token-${this.issued}`;
		const refreshToken = `synthetic-refresh-token-${this.issued}`;
		this.refreshTokens.push(refreshToken);
		return json({
			access_token: this.accessToken,
			expires_in: 3599,
			refresh_token: refreshToken,
			scope:
				"https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
			token_type: "Bearer",
		});
	}

	private answer(
		request: Request,
		bytes: Uint8Array
	): Response | Promise<Response> {
		const url = new URL(request.url);
		if (this.tunnels.answers(url)) {
			return this.tunnels.forward(request, url, bytes);
		}
		const body = new TextDecoder().decode(bytes);
		this.received.push({
			authorization: request.headers.get("authorization"),
			body,
			method: request.method,
			prefer: request.headers.get("prefer"),
			url,
		});
		if (isReleaseRequest(url)) {
			return this.releases.answer(url);
		}
		if (url.hostname === loginHost) {
			return this.login(url, new URLSearchParams(body));
		}
		if (url.origin === uploadOrigin) {
			return this.upload(url, request, bytes);
		}
		if (request.headers.get("authorization") !== `Bearer ${this.accessToken}`) {
			return graphError(
				401,
				"InvalidAuthenticationToken",
				"Access token is empty or invalid."
			);
		}
		const key = `${request.method} ${url.href}`;
		const throttled = this.throttled.get(key) ?? 0;
		if (this.throttle > 0 || throttled < this.throttleEach) {
			if (this.throttle > 0) {
				this.throttle -= 1;
			} else {
				this.throttled.set(key, throttled + 1);
			}
			return json(
				{
					error: {
						code: "ApplicationThrottled",
						message: "Synthetic throttle.",
					},
				},
				429,
				{ "retry-after": String(this.retryAfter) }
			);
		}
		if (this.outage > 0) {
			return graphError(this.outage, "ServiceUnavailable", "Synthetic outage.");
		}
		const asText =
			request.headers
				.get("prefer")
				?.includes('outlook.body-content-type="text"') ?? false;
		return this.graph(
			request.method,
			url,
			body === "" ? {} : (JSON.parse(body) as Json),
			asText
		);
	}

	private login(url: URL, form: URLSearchParams) {
		if (url.pathname.endsWith("/oauth2/v2.0/devicecode")) {
			return json({
				device_code: "synthetic-device-code",
				expires_in: 900,
				interval: 1,
				message: `To sign in, open ${verificationUri} and enter the code ${userCode}.`,
				user_code: userCode,
				verification_uri: verificationUri,
			});
		}
		const grant = form.get("grant_type");
		if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
			if (this.pendingPolls > 0) {
				this.pendingPolls -= 1;
				return json(
					{
						error: "authorization_pending",
						error_description: "AADSTS70016: Pending.",
					},
					400
				);
			}
			return this.issue();
		}
		if (
			grant === "refresh_token" &&
			!this.refuseRefresh &&
			this.refreshTokens.includes(form.get("refresh_token") ?? "")
		) {
			return this.issue();
		}
		return json(
			{
				error: "invalid_grant",
				error_description: "AADSTS70043: Synthetic expired grant.",
			},
			400
		);
	}

	private folderJson(id: string) {
		const folder = this.folders.get(id);
		return {
			childFolderCount: Arr.filter(
				[...this.folders.values()],
				(child) => child.parentFolderId === id
			).length,
			displayName: folder?.displayName,
			id,
			parentFolderId: folder?.parentFolderId,
			totalItemCount: this.inFolder(id).length,
		};
	}

	private foldersUnder(parentFolderId: string) {
		return Arr.map(
			Arr.filter(
				[...this.folders.entries()],
				([, folder]) => folder.parentFolderId === parentFolderId
			),
			([id]) => this.folderJson(id)
		);
	}

	private messageJson(message: FakeMessage, asText: boolean) {
		const contentType = asText ? "text" : "html";
		return {
			bccRecipients: recipients(message.bcc),
			body: { content: message.body, contentType },
			categories: message.categories,
			ccRecipients: recipients(message.cc),
			conversationId: message.conversationId,
			flag: { flagStatus: message.flag },
			from: message.from === null ? null : { emailAddress: message.from },
			hasAttachments: Arr.some(
				message.attachments,
				(attachment) => !attachment.isInline
			),
			id: message.id,
			importance: "normal",
			internetMessageId: `<${message.id}@example.test>`,
			isDraft: message.isDraft,
			isRead: message.isRead,
			parentFolderId: message.parentFolderId,
			receivedDateTime: message.received,
			sentDateTime: message.sent,
			subject: message.subject,
			toRecipients: recipients(message.to),
			uniqueBody: { content: message.uniqueBody, contentType },
		};
	}

	private delta(folderId: string, url: URL, asText: boolean) {
		const self = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta`;
		const token = url.searchParams.get("$deltatoken");
		if (token === null) {
			const all = Arr.filter(
				[...this.messages.values()],
				(message) => message.parentFolderId === folderId
			);
			const offset = Number(url.searchParams.get("$skiptoken") ?? "0");
			const more = offset + 2 < all.length;
			if (!more) {
				this.roundsEnded.push(folderId);
			}
			return json({
				value: this.entries(
					folderId,
					false,
					Arr.map(all.slice(offset, offset + 2), (message) =>
						this.messageJson(message, asText)
					)
				),
				...(more
					? { "@odata.nextLink": `${self}?$skiptoken=${offset + 2}` }
					: {
							"@odata.deltaLink": `${self}?$deltatoken=${this.changes.length}`,
						}),
			});
		}
		const changes = Arr.filter(
			this.changes.slice(Number(token)),
			(change) => change.folderId === folderId
		);
		const ids = Arr.dedupe(Arr.map(changes, (change) => change.id));
		this.roundsEnded.push(folderId);
		return json({
			"@odata.deltaLink": `${self}?$deltatoken=${this.changes.length}`,
			value: this.entries(
				folderId,
				false,
				Arr.map(ids, (id) => {
					const message = this.messages.get(id);
					if (message === undefined || message.parentFolderId !== folderId) {
						return {
							"@odata.type": "#microsoft.graph.message",
							"@removed": { reason: "deleted" },
							id,
						};
					}
					return Arr.every(
						changes,
						(change) => change.id !== id || change.partial === true
					)
						? {
								"@odata.type": "#microsoft.graph.message",
								id,
								isRead: message.isRead,
								parentFolderId: message.parentFolderId,
							}
						: this.messageJson(message, asText);
				})
			),
		});
	}

	/**
	 * The ids of the folder's messages, for `$select=id`. Graph serves up to `$top` per page; here a page holds 2, so a
	 * listing takes several pages, as a large folder does.
	 */
	private messageIds(folderId: string, url: URL) {
		if (url.searchParams.get("$select") !== "id") {
			return graphError(
				400,
				"ErrorInvalidRequest",
				"The fake lists messages only with $select=id."
			);
		}
		const all = this.inFolder(folderId);
		const offset = Number(url.searchParams.get("$skip") ?? "0");
		const next = new URL(url);
		next.searchParams.set("$skip", String(offset + 2));
		return json({
			value: this.entries(
				folderId,
				true,
				Arr.map(all.slice(offset, offset + 2), ({ id }) => ({ id }))
			),
			...(offset + 2 < all.length ? { "@odata.nextLink": next.href } : {}),
		});
	}

	private draft(
		input: Pick<
			FakeMessage,
			"bcc" | "body" | "cc" | "conversationId" | "subject" | "to"
		> & { uniqueBody: string },
		folder: "folder-drafts" | "folder-sent" = "folder-drafts"
	) {
		const sent = folder === "folder-sent";
		return this.add({
			...input,
			from: sent ? owner : null,
			id: this.newId("message"),
			isDraft: !sent,
			isRead: true,
			parentFolderId: folder,
			received: "2026-10-05T10:00:00Z",
			sent: sent ? "2026-10-05T10:00:00Z" : null,
		});
	}

	/**
	 * The reply, reply-all or forward Outlook builds for `message`: the comment above the quoted message, the original's
	 * recipients, and any `message` properties the request gives in their place.
	 */
	private reaction(
		action: string,
		message: FakeMessage,
		body: Json,
		folder: "folder-drafts" | "folder-sent"
	) {
		const forward = action.toLowerCase().includes("forward");
		const all = action.toLowerCase().includes("replyall");
		const comment = String(body.comment ?? "");
		const changes = (body.message ?? {}) as Json;
		const from = Option.toArray(Option.fromNullishOr(message.from));
		const others = Arr.filter(
			message.to,
			(address) => address.address !== owner.address
		);
		const replyTo = all ? [...from, ...others] : from;
		const defaultTo = forward ? parseRecipients(body.toRecipients) : replyTo;
		const defaultCc = all ? message.cc : [];
		return this.draft(
			{
				bcc: parseRecipients(changes.bccRecipients),
				body: `${comment}\r\n\r\nFrom: ${message.from?.name}\r\n${message.body}`,
				cc:
					changes.ccRecipients === undefined
						? defaultCc
						: parseRecipients(changes.ccRecipients),
				conversationId: message.conversationId,
				subject:
					changes.subject === undefined
						? `${forward ? "FW" : "RE"}: ${message.subject}`
						: String(changes.subject),
				to:
					changes.toRecipients === undefined
						? defaultTo
						: parseRecipients(changes.toRecipients),
				uniqueBody: comment,
			},
			folder
		);
	}

	private newMessage(body: Json, folder: "folder-drafts" | "folder-sent") {
		return this.draft(
			{
				bcc: parseRecipients(body.bccRecipients),
				body: content(body.body),
				cc: parseRecipients(body.ccRecipients),
				conversationId: this.newId("conversation"),
				subject: String(body.subject),
				to: parseRecipients(body.toRecipients),
				uniqueBody: content(body.body),
			},
			folder
		);
	}

	private graph(
		method: string,
		url: URL,
		body: Json,
		asText: boolean
	): Response | Promise<Response> {
		const parts = decodeURIComponent(url.pathname).split("/");
		if (parts[2] === "subscriptions") {
			return this.subscriptions.answer(method, parts[3], parts[4], body);
		}
		const [, , , collection, id, action, attachmentId, value] = parts;
		if (collection === "mailFolders") {
			return this.folderRequest(url, asText, id, action, attachmentId);
		}
		if (collection === "sendMail") {
			this.newMessage(body.message as Json, "folder-sent");
			return new Response(null, { status: 202 });
		}
		if (id === undefined) {
			return json(
				this.messageJson(this.newMessage(body, "folder-drafts"), asText),
				201
			);
		}
		const message = this.messages.get(id);
		if (message === undefined) {
			return graphError(
				404,
				"ErrorItemNotFound",
				"The specified object was not found in the store."
			);
		}
		if (action === "attachments") {
			return this.attachmentRequest(method, message, body, attachmentId, value);
		}
		return this.messageRequest(method, message, body, asText, action);
	}

	private folderRequest(
		url: URL,
		asText: boolean,
		id: string | undefined,
		action: string | undefined,
		messagesAction: string | undefined
	) {
		if (id === undefined) {
			return json({ value: this.foldersUnder("folder-root") });
		}
		const folderId = wellKnown[id] ?? id;
		if (!this.folders.has(folderId)) {
			return graphError(
				404,
				"ErrorItemNotFound",
				"The specified object was not found in the store."
			);
		}
		if (action === "childFolders") {
			return json({ value: this.foldersUnder(folderId) });
		}
		if (action === "messages" && messagesAction === "delta") {
			return this.delta(folderId, url, asText);
		}
		if (action === "messages") {
			return this.messageIds(folderId, url);
		}
		return json(this.folderJson(folderId));
	}

	/** Logs the change and answers the message as Graph holds it now. */
	private touched(message: FakeMessage, status: number, asText: boolean) {
		this.changes.push({ folderId: message.parentFolderId, id: message.id });
		return json(this.messageJson(message, asText), status);
	}

	private patch(message: FakeMessage, body: Json) {
		if (typeof body.isRead === "boolean") {
			message.isRead = body.isRead;
		}
		if (body.flag !== undefined) {
			message.flag = (
				body.flag as { flagStatus: FakeMessage["flag"] }
			).flagStatus;
		}
		if (Arr.isArray(body.categories)) {
			message.categories = Arr.map(body.categories, String);
		}
		if (body.body !== undefined) {
			message.body = content(body.body);
			message.uniqueBody = message.body;
		}
		if (body.subject !== undefined) {
			message.subject = String(body.subject);
		}
		for (const [field, key] of [
			["toRecipients", "to"],
			["ccRecipients", "cc"],
			["bccRecipients", "bcc"],
		] as const) {
			if (body[field] !== undefined) {
				message[key] = parseRecipients(body[field]);
			}
		}
	}

	private messageRequest(
		method: string,
		message: FakeMessage,
		body: Json,
		asText: boolean,
		action: string | undefined
	) {
		if (action === undefined && method === "GET") {
			const answer = json(this.messageJson(message, asText));
			if (this.vanishing.delete(message.id)) {
				this.purge(message.id);
			}
			return answer;
		}
		if (action === undefined && method === "PATCH") {
			this.patch(message, body);
			return this.touched(message, 200, asText);
		}
		if (action === "move") {
			this.changes.push({ folderId: message.parentFolderId, id: message.id });
			const destination = String(body.destinationId);
			message.parentFolderId = wellKnown[destination] ?? destination;
			return this.touched(message, 201, asText);
		}
		if (
			action === "createReply" ||
			action === "createReplyAll" ||
			action === "createForward"
		) {
			const created = this.reaction(action, message, body, "folder-drafts");
			return json(this.messageJson(created, asText), 201);
		}
		if (action === "reply" || action === "replyAll" || action === "forward") {
			this.reaction(action, message, body, "folder-sent");
			return new Response(null, { status: 202 });
		}
		if (action === "send" && message.isDraft) {
			this.changes.push({ folderId: message.parentFolderId, id: message.id });
			message.isDraft = false;
			message.parentFolderId = "folder-sent";
			this.changes.push({ folderId: message.parentFolderId, id: message.id });
			return new Response(null, { status: 202 });
		}
		return graphError(
			405,
			"ErrorInvalidRequest",
			"The fake does not answer this request."
		);
	}

	private attachmentRequest(
		method: string,
		message: FakeMessage,
		body: Json,
		attachmentId: string | undefined,
		value: string | undefined
	) {
		if (attachmentId === undefined && method === "GET") {
			return json({
				value: Arr.map(message.attachments, (attachment) => ({
					"@odata.type": "#microsoft.graph.fileAttachment",
					contentBytes: Base64.encode(attachment.bytes),
					contentId: attachment.contentId,
					contentType: attachment.type,
					id: attachment.id,
					isInline: attachment.isInline,
					name: attachment.name,
					size: attachment.bytes.length,
				})),
			});
		}
		if (value === "$value") {
			return Option.match(
				Arr.findFirst(
					message.attachments,
					(attachment) => attachment.id === attachmentId
				),
				{
					onNone: () =>
						graphError(404, "ErrorItemNotFound", "No such attachment."),
					onSome: (attachment) =>
						new Response(attachment.bytes, {
							headers: { "content-type": attachment.type },
						}),
				}
			);
		}
		if (attachmentId === "createUploadSession") {
			const item = body.AttachmentItem as { name: string; size: number };
			const session = this.newId("upload");
			this.uploads.set(session, {
				chunks: [],
				messageId: message.id,
				name: item.name,
				size: item.size,
			});
			return json({ uploadUrl: `${uploadOrigin}/sessions/${session}` }, 201);
		}
		message.attachments.push({
			bytes: new TextEncoder().encode(String(body.contentBytes)),
			contentId: null,
			id: this.newId("attachment"),
			isInline: false,
			name: String(body.name),
			type: "application/octet-stream",
		});
		return this.touched(message, 201, false);
	}

	private upload(url: URL, request: Request, bytes: Uint8Array) {
		const session = this.uploads.get(url.pathname.split("/").at(-1) ?? "");
		if (
			session === undefined ||
			request.headers.get("authorization") !== null
		) {
			return new Response(null, { status: 401 });
		}
		session.chunks.push(bytes);
		const received = Arr.reduce(
			session.chunks,
			0,
			(total, chunk) => total + chunk.length
		);
		if (received < session.size) {
			return json({ nextExpectedRanges: [`${received}-`] });
		}
		this.messages.get(session.messageId)?.attachments.push({
			bytes: new Uint8Array(),
			contentId: null,
			id: this.newId("attachment"),
			isInline: false,
			name: session.name,
			type: "application/octet-stream",
		});
		return new Response(null, { status: 201 });
	}
}
