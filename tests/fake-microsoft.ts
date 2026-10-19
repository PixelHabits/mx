import {
	Array as Arr,
	Duration,
	Effect,
	Layer,
	Option,
	pipe,
	String as Str,
} from "effect";
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

/** The folder ids Graph answers for the well-known names mx sends, in the default mailbox; another's start with its prefix. */
const wellKnown: Record<string, string> = {
	archive: "folder-archive",
	deleteditems: "folder-deleted",
	drafts: "folder-drafts",
	inbox: "folder-inbox",
	msgfolderroot: "folder-root",
	sentitems: "folder-sent",
};

/** The folders below the root that every mailbox starts with, by their ids in the default mailbox. */
const startingFolders = [
	["folder-inbox", "Inbox"],
	["folder-sent", "Sent Items"],
	["folder-drafts", "Drafts"],
	["folder-deleted", "Deleted Items"],
	["folder-archive", "Archive"],
] as const;

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

const notFound = () =>
	graphError(
		404,
		"ErrorItemNotFound",
		"The specified object was not found in the store."
	);

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
 * One synthetic user's mailbox as Graph holds it: its folders and messages, the change log its delta links replay, its
 * push subscriptions and the user's sign-in. Every folder, message and subscription id starts with `prefix`, so no id
 * is in two mailboxes; the default mailbox's prefix is empty.
 */
export class FakeMailbox {
	/** The newest access token Microsoft issued for this mailbox, the only one Graph answers for it. */
	accessToken = "";
	/** The refresh tokens Microsoft issued for this mailbox, oldest first. */
	readonly refreshTokens: string[] = [];
	/** When set, a refresh of this mailbox's sign-in answers `invalid_grant`. */
	refuseRefresh = false;
	readonly subscriptions: FakeSubscriptions;
	readonly folders = new Map<
		string,
		{ readonly displayName: string; readonly parentFolderId: string }
	>();
	readonly messages = new Map<string, FakeMessage>();
	/**
	 * Each change names the folder it touched, in order; a change Graph reports with only the properties that changed is
	 * `partial`.
	 */
	readonly changes: {
		readonly folderId: string;
		readonly id: string;
		readonly partial?: true;
	}[] = [];
	private nextId = 100;

	readonly prefix: string;
	readonly user: Address;

	constructor(prefix: string, user: Address, tunnels: FakeTunnels) {
		this.prefix = prefix;
		this.user = user;
		this.subscriptions = new FakeSubscriptions(tunnels, prefix);
		for (const [id, displayName] of startingFolders) {
			this.folders.set(`${prefix}${id}`, {
				displayName,
				parentFolderId: this.resolve("msgfolderroot"),
			});
		}
	}

	/** The folder id Graph reads `name` as here: this mailbox's folder for a well-known name such as `inbox`, else `name`. */
	resolve(name: string) {
		const id = wellKnown[name];
		return id === undefined ? name : `${this.prefix}${id}`;
	}

	/** Whether `id` is this mailbox's root folder, or a folder or message in it. */
	holds(id: string) {
		return (
			id === this.resolve("msgfolderroot") ||
			this.folders.has(id) ||
			this.messages.has(id)
		);
	}

	newId(kind: string) {
		this.nextId += 1;
		return `${this.prefix}${kind}-${this.nextId}`;
	}

	/** The messages in a folder as Graph holds them now. */
	inFolder(folderId: string): readonly FakeMessage[] {
		return Arr.filter(
			[...this.messages.values()],
			(message) => message.parentFolderId === folderId
		);
	}

	/** Adds a message to its folder and logs the change. */
	add(
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
}

/** The device code Microsoft issues when the user of `mailbox` signs in. */
const deviceCode = (mailbox: FakeMailbox) =>
	`${mailbox.prefix}synthetic-device-code`;

/**
 * Microsoft's token endpoint and Graph for synthetic mailboxes, in memory: the default mailbox, and any that
 * `addMailbox` adds. Each issued access and refresh token carries a counter and belongs to one mailbox; a refresh token
 * stays valid after it is used, as Entra's do. Graph answers a request from the mailbox whose newest access token it
 * bears, honours `Prefer: outlook.body-content-type="text"` and keeps a change log per folder that its delta links
 * replay. Upload URLs refuse a bearer token, as Graph's do. A method that takes a folder or message id acts in the
 * mailbox that holds it.
 */
export class FakeMicrosoft {
	readonly received: Received[] = [];
	readonly tunnels = new FakeTunnels();
	/** The mailbox the tests use unless they add another: Sam's, with folder ids such as `folder-inbox`. */
	readonly mailbox = new FakeMailbox("", owner, this.tunnels);
	/** The default mailbox's push subscriptions. */
	readonly subscriptions = this.mailbox.subscriptions;
	/** The mailbox whose user enters the code at the verification URI: each device code issued from now on signs it in. */
	signingIn = this.mailbox;
	private readonly mailboxes = [this.mailbox];
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
	/** The refresh tokens Microsoft issued for every mailbox, oldest first. */
	readonly refreshTokens: string[] = [];
	private issued = 0;
	/** The reads of a folder, its delta pages or the listing of its message ids, that Graph answers in a form mx cannot read. */
	private readonly unreadables = new Set<string>();
	private readonly uploads = new Map<
		string,
		{
			chunks: Uint8Array[];
			readonly mailbox: FakeMailbox;
			readonly messageId: string;
			readonly name: string;
			readonly size: number;
		}
	>();

	private readonly releases: FakeReleases;

	constructor(releases: FakeReleases) {
		this.releases = releases;
		this.addFolder("folder-projects", "Projects", "folder-inbox");
		this.mailbox.add({
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
		this.mailbox.add({
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
		this.mailbox.add({
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
		this.mailbox.add({
			body: "Kickoff is on Thursday.",
			conversationId: "conversation-kickoff",
			from: bob,
			id: "message-kickoff",
			parentFolderId: "folder-projects",
			received: "2026-10-02T09:00:00Z",
			subject: "Kickoff notes",
			to: [owner],
		});
		this.mailbox.add({
			body: "Lunch on Friday?",
			conversationId: "conversation-lunch",
			from: carol,
			// An immutable id as Graph gives it, with - and _ where standard base64 has / and +.
			id: "AAkALgAAAAAASyNtHeTiCmAiLbOxIdAC-EWg0ASyNtHeTiC_iD0000TeStMaIlBoX0AA",
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
	 * Adds the mailbox of another user, with the folders every mailbox starts with and no mail. Its folder, message and
	 * subscription ids start with `name`, so none is in another mailbox. A test signs in to it through `signingIn`.
	 */
	addMailbox(name: string, user: Address) {
		const mailbox = new FakeMailbox(`${name}-`, user, this.tunnels);
		this.mailboxes.push(mailbox);
		return mailbox;
	}

	/** The mailbox that holds `id`, a folder or message id, or the default mailbox when none does. */
	private mailboxOf(id: string) {
		return Option.getOrElse(
			Arr.findFirst(this.mailboxes, (mailbox) => mailbox.holds(id)),
			() => this.mailbox
		);
	}

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
		const [, , , collection, id = "", messages, delta] = pipe(
			decodeURIComponent(url.pathname),
			Str.split("/")
		);
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
		const mailbox = this.mailboxOf(id);
		const message = mailbox.messages.get(id);
		if (message !== undefined) {
			mailbox.messages.delete(id);
			mailbox.changes.push({ folderId: message.parentFolderId, id });
		}
	}

	/** Moves a message the way Outlook does, so the next delta reports it removed from its folder and added to `folderId`. */
	move(id: string, folderId: string) {
		const mailbox = this.mailboxOf(id);
		const message = mailbox.messages.get(id);
		if (message !== undefined) {
			mailbox.changes.push({ folderId: message.parentFolderId, id });
			message.parentFolderId = folderId;
			mailbox.changes.push({ folderId, id });
		}
	}

	/** Marks a message read the way Outlook does, so the next delta reports only its `isRead` and `parentFolderId`. */
	readInOutlook(id: string) {
		const mailbox = this.mailboxOf(id);
		const message = mailbox.messages.get(id);
		if (message !== undefined) {
			message.isRead = true;
			mailbox.changes.push({
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

	/** Adds a mail folder below `parentFolderId`, in its mailbox, as the user makes one in Outlook. */
	addFolder(id: string, displayName: string, parentFolderId: string) {
		this.mailboxOf(parentFolderId).folders.set(id, {
			displayName,
			parentFolderId,
		});
	}

	/** Deletes a mail folder, the folders in it and their messages for good. */
	removeFolder(id: string) {
		const mailbox = this.mailboxOf(id);
		for (const [child, { parentFolderId }] of [...mailbox.folders]) {
			if (parentFolderId === id) {
				this.removeFolder(child);
			}
		}
		mailbox.folders.delete(id);
		for (const message of mailbox.inFolder(id)) {
			mailbox.messages.delete(message.id);
		}
	}

	/** The id of the one folder named `displayName`, in any mailbox. */
	folderId(displayName: string) {
		const [id, ...others] = Arr.map(
			Arr.filter(
				Arr.flatMap(this.mailboxes, (mailbox) => [...mailbox.folders]),
				([, folder]) => folder.displayName === displayName
			),
			([folderId]) => folderId
		);
		if (id === undefined || others.length > 0) {
			throw new Error(`Expected one folder named ${displayName}.`);
		}
		return id;
	}

	/** A message from Bob arrives in the Inbox of `mailbox`, and Graph notifies that Inbox's subscriptions. */
	receive(subject: string, mailbox = this.mailbox) {
		const added = mailbox.add({
			body: `${subject}, in the body.`,
			conversationId: mailbox.newId("conversation"),
			from: bob,
			id: mailbox.newId("message"),
			parentFolderId: mailbox.resolve("inbox"),
			received: "2026-10-06T08:00:00Z",
			subject,
			to: [mailbox.user],
		});
		return mailbox.subscriptions.notify("inbox", added.id);
	}

	/** A message to the user arrives in a folder without a notification, so the next pass brings it in. */
	deliver(
		message: Pick<
			FakeMessage,
			"body" | "conversationId" | "parentFolderId" | "received" | "subject"
		> & { readonly from: Address }
	) {
		const mailbox = this.mailboxOf(message.parentFolderId);
		return mailbox.add({
			...message,
			id: mailbox.newId("message"),
			to: [mailbox.user],
		});
	}

	/** The messages in a folder as Graph holds them now. */
	inFolder(folderId: string): readonly FakeMessage[] {
		return this.mailboxOf(folderId).inFolder(folderId);
	}

	graphRequests() {
		return Arr.filter(
			this.received,
			(request) => request.url.hostname === "graph.microsoft.com"
		);
	}

	/**
	 * Makes the changes `change` makes to messages leave no trace in any delta, as changes Graph's delta misses. No delta
	 * link is issued while it runs, so dropping the changes it logged moves no link.
	 */
	missedByDelta(change: () => void) {
		const logged = Arr.map(
			this.mailboxes,
			(mailbox) => [mailbox, mailbox.changes.length] as const
		);
		change();
		for (const [mailbox, length] of logged) {
			mailbox.changes.splice(length);
		}
	}

	/** Signs in `mailbox` with a new access token, which Graph answers in place of its last, and a refresh token. */
	private issue(mailbox: FakeMailbox) {
		this.issued += 1;
		mailbox.accessToken = `synthetic-access-token-${this.issued}`;
		const refreshToken = `synthetic-refresh-token-${this.issued}`;
		this.refreshTokens.push(refreshToken);
		mailbox.refreshTokens.push(refreshToken);
		return json({
			access_token: mailbox.accessToken,
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
		const authorization = request.headers.get("authorization");
		this.received.push({
			authorization,
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
		const mailbox = Arr.findFirst(
			this.mailboxes,
			(candidate) => authorization === `Bearer ${candidate.accessToken}`
		);
		if (Option.isNone(mailbox)) {
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
		const asText = pipe(
			request.headers.get("prefer") ?? "",
			Str.includes('outlook.body-content-type="text"')
		);
		return this.graph(
			mailbox.value,
			request.method,
			url,
			body === "" ? {} : (JSON.parse(body) as Json),
			asText
		);
	}

	/** Answers the token endpoint: a device code redeems for its mailbox, and a refresh token for the mailbox it belongs to. */
	private login(url: URL, form: URLSearchParams) {
		if (pipe(url.pathname, Str.endsWith("/oauth2/v2.0/devicecode"))) {
			return json({
				device_code: deviceCode(this.signingIn),
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
			const signedIn = Arr.findFirst(
				this.mailboxes,
				(mailbox) => deviceCode(mailbox) === form.get("device_code")
			);
			if (Option.isSome(signedIn)) {
				return this.issue(signedIn.value);
			}
		}
		if (grant === "refresh_token" && !this.refuseRefresh) {
			const refreshed = Arr.findFirst(
				this.mailboxes,
				(mailbox) =>
					!mailbox.refuseRefresh &&
					mailbox.refreshTokens.includes(form.get("refresh_token") ?? "")
			);
			if (Option.isSome(refreshed)) {
				return this.issue(refreshed.value);
			}
		}
		return json(
			{
				error: "invalid_grant",
				error_description: "AADSTS70043: Synthetic expired grant.",
			},
			400
		);
	}

	private folderJson(mailbox: FakeMailbox, id: string) {
		const folder = mailbox.folders.get(id);
		return {
			childFolderCount: Arr.filter(
				[...mailbox.folders.values()],
				(child) => child.parentFolderId === id
			).length,
			displayName: folder?.displayName,
			id,
			parentFolderId: folder?.parentFolderId,
			totalItemCount: mailbox.inFolder(id).length,
		};
	}

	private foldersUnder(mailbox: FakeMailbox, parentFolderId: string) {
		return Arr.map(
			Arr.filter(
				[...mailbox.folders.entries()],
				([, folder]) => folder.parentFolderId === parentFolderId
			),
			([id]) => this.folderJson(mailbox, id)
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

	private delta(
		mailbox: FakeMailbox,
		folderId: string,
		url: URL,
		asText: boolean
	) {
		const self = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta`;
		const token = url.searchParams.get("$deltatoken");
		if (token === null) {
			const all = mailbox.inFolder(folderId);
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
							"@odata.deltaLink": `${self}?$deltatoken=${mailbox.changes.length}`,
						}),
			});
		}
		const changes = Arr.filter(
			mailbox.changes.slice(Number(token)),
			(change) => change.folderId === folderId
		);
		const ids = Arr.dedupe(Arr.map(changes, (change) => change.id));
		this.roundsEnded.push(folderId);
		return json({
			"@odata.deltaLink": `${self}?$deltatoken=${mailbox.changes.length}`,
			value: this.entries(
				folderId,
				false,
				Arr.map(ids, (id) => {
					const message = mailbox.messages.get(id);
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
	private messageIds(mailbox: FakeMailbox, folderId: string, url: URL) {
		if (url.searchParams.get("$select") !== "id") {
			return graphError(
				400,
				"ErrorInvalidRequest",
				"The fake lists messages only with $select=id."
			);
		}
		const all = mailbox.inFolder(folderId);
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
		mailbox: FakeMailbox,
		input: Pick<
			FakeMessage,
			"bcc" | "body" | "cc" | "conversationId" | "subject" | "to"
		> & { uniqueBody: string },
		folder: "drafts" | "sentitems" = "drafts"
	) {
		const sent = folder === "sentitems";
		return mailbox.add({
			...input,
			from: sent ? mailbox.user : null,
			id: mailbox.newId("message"),
			isDraft: !sent,
			isRead: true,
			parentFolderId: mailbox.resolve(folder),
			received: "2026-10-05T10:00:00Z",
			sent: sent ? "2026-10-05T10:00:00Z" : null,
		});
	}

	/**
	 * The reply, reply-all or forward Outlook builds for `message`: the comment above the quoted message, the original's
	 * recipients, and any `message` properties the request gives in their place.
	 */
	private reaction(
		mailbox: FakeMailbox,
		action: string,
		message: FakeMessage,
		body: Json,
		folder: "drafts" | "sentitems"
	) {
		const forward = pipe(action, Str.toLowerCase, Str.includes("forward"));
		const all = pipe(action, Str.toLowerCase, Str.includes("replyall"));
		const comment = String(body.comment ?? "");
		const changes = (body.message ?? {}) as Json;
		const from = Option.toArray(Option.fromNullishOr(message.from));
		const others = Arr.filter(
			message.to,
			(address) => address.address !== mailbox.user.address
		);
		const replyTo = all ? [...from, ...others] : from;
		const defaultTo = forward ? parseRecipients(body.toRecipients) : replyTo;
		const defaultCc = all ? message.cc : [];
		return this.draft(
			mailbox,
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

	private newMessage(
		mailbox: FakeMailbox,
		body: Json,
		folder: "drafts" | "sentitems"
	) {
		return this.draft(
			mailbox,
			{
				bcc: parseRecipients(body.bccRecipients),
				body: content(body.body),
				cc: parseRecipients(body.ccRecipients),
				conversationId: mailbox.newId("conversation"),
				subject: String(body.subject),
				to: parseRecipients(body.toRecipients),
				uniqueBody: content(body.body),
			},
			folder
		);
	}

	/** Graph's answer to a request from `mailbox`, which sees only its own folders, messages and subscriptions. */
	private graph(
		mailbox: FakeMailbox,
		method: string,
		url: URL,
		body: Json,
		asText: boolean
	): Response | Promise<Response> {
		const parts = pipe(decodeURIComponent(url.pathname), Str.split("/"));
		if (parts[2] === "subscriptions") {
			return mailbox.subscriptions.answer(method, parts[3], parts[4], body);
		}
		const [, , , collection, id, action, attachmentId, value] = parts;
		if (collection === "mailFolders") {
			return this.folderRequest(
				mailbox,
				{ body, method, url },
				asText,
				id,
				action,
				attachmentId
			);
		}
		if (collection === "sendMail") {
			this.newMessage(mailbox, body.message as Json, "sentitems");
			return new Response(null, { status: 202 });
		}
		if (id === undefined) {
			return json(
				this.messageJson(this.newMessage(mailbox, body, "drafts"), asText),
				201
			);
		}
		const message = mailbox.messages.get(id);
		if (message === undefined) {
			return notFound();
		}
		if (action === "attachments") {
			return this.attachmentRequest(
				mailbox,
				method,
				message,
				body,
				attachmentId,
				value
			);
		}
		return this.messageRequest(mailbox, method, message, body, asText, action);
	}

	private folderRequest(
		mailbox: FakeMailbox,
		{ body, method, url }: { body: Json; method: string; url: URL },
		asText: boolean,
		id: string | undefined,
		action: string | undefined,
		messagesAction: string | undefined
	) {
		const root = mailbox.resolve("msgfolderroot");
		if (id === undefined) {
			return method === "POST"
				? this.placeFolder(
						mailbox,
						mailbox.newId("folder"),
						String(body.displayName),
						root,
						201
					)
				: json({ value: this.foldersUnder(mailbox, root) });
		}
		const folderId = mailbox.resolve(id);
		const folder = mailbox.folders.get(folderId);
		if (folder === undefined) {
			return notFound();
		}
		if (action === "childFolders") {
			return method === "POST"
				? this.placeFolder(
						mailbox,
						mailbox.newId("folder"),
						String(body.displayName),
						folderId,
						201
					)
				: json({ value: this.foldersUnder(mailbox, folderId) });
		}
		if (action === "move") {
			const parentFolderId = mailbox.resolve(String(body.destinationId));
			return parentFolderId === root || mailbox.folders.has(parentFolderId)
				? this.placeFolder(
						mailbox,
						folderId,
						folder.displayName,
						parentFolderId,
						201
					)
				: notFound();
		}
		if (action === "messages" && messagesAction === "delta") {
			return this.delta(mailbox, folderId, url, asText);
		}
		if (action === "messages") {
			return this.messageIds(mailbox, folderId, url);
		}
		if (method === "PATCH") {
			return this.placeFolder(
				mailbox,
				folderId,
				String(body.displayName),
				folder.parentFolderId,
				200
			);
		}
		if (method === "GET") {
			return json(this.folderJson(mailbox, folderId));
		}
		return graphError(
			405,
			"ErrorInvalidRequest",
			"The fake does not answer this request."
		);
	}

	/**
	 * Names and places a folder, created, renamed or moved, and answers it with `status`; Graph refuses a second folder
	 * of a name in one parent, in any case.
	 */
	private placeFolder(
		mailbox: FakeMailbox,
		id: string,
		displayName: string,
		parentFolderId: string,
		status: number
	) {
		const taken = Arr.some(
			[...mailbox.folders],
			([other, folder]) =>
				other !== id &&
				folder.parentFolderId === parentFolderId &&
				Str.toLowerCase(folder.displayName) === Str.toLowerCase(displayName)
		);
		if (taken) {
			return graphError(
				409,
				"ErrorFolderExists",
				"A folder with the specified name already exists."
			);
		}
		mailbox.folders.set(id, { displayName, parentFolderId });
		return json(this.folderJson(mailbox, id), status);
	}

	/** Logs the change and answers the message as Graph holds it now. */
	private touched(
		mailbox: FakeMailbox,
		message: FakeMessage,
		status: number,
		asText: boolean
	) {
		mailbox.changes.push({ folderId: message.parentFolderId, id: message.id });
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
		mailbox: FakeMailbox,
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
			return this.touched(mailbox, message, 200, asText);
		}
		if (action === "move") {
			mailbox.changes.push({
				folderId: message.parentFolderId,
				id: message.id,
			});
			message.parentFolderId = mailbox.resolve(String(body.destinationId));
			return this.touched(mailbox, message, 201, asText);
		}
		if (
			action === "createReply" ||
			action === "createReplyAll" ||
			action === "createForward"
		) {
			const created = this.reaction(mailbox, action, message, body, "drafts");
			return json(this.messageJson(created, asText), 201);
		}
		if (action === "reply" || action === "replyAll" || action === "forward") {
			this.reaction(mailbox, action, message, body, "sentitems");
			return new Response(null, { status: 202 });
		}
		if (action === "send" && message.isDraft) {
			mailbox.changes.push({
				folderId: message.parentFolderId,
				id: message.id,
			});
			message.isDraft = false;
			message.parentFolderId = mailbox.resolve("sentitems");
			mailbox.changes.push({
				folderId: message.parentFolderId,
				id: message.id,
			});
			return new Response(null, { status: 202 });
		}
		return graphError(
			405,
			"ErrorInvalidRequest",
			"The fake does not answer this request."
		);
	}

	private attachmentRequest(
		mailbox: FakeMailbox,
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
			const session = mailbox.newId("upload");
			this.uploads.set(session, {
				chunks: [],
				mailbox,
				messageId: message.id,
				name: item.name,
				size: item.size,
			});
			return json({ uploadUrl: `${uploadOrigin}/sessions/${session}` }, 201);
		}
		message.attachments.push({
			bytes: new TextEncoder().encode(String(body.contentBytes)),
			contentId: null,
			id: mailbox.newId("attachment"),
			isInline: false,
			name: String(body.name),
			type: "application/octet-stream",
		});
		return this.touched(mailbox, message, 201, false);
	}

	private upload(url: URL, request: Request, bytes: Uint8Array) {
		const session = this.uploads.get(
			Arr.lastNonEmpty(pipe(url.pathname, Str.split("/")))
		);
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
		session.mailbox.messages.get(session.messageId)?.attachments.push({
			bytes: new Uint8Array(),
			contentId: null,
			id: session.mailbox.newId("attachment"),
			isInline: false,
			name: session.name,
			type: "application/octet-stream",
		});
		return new Response(null, { status: 201 });
	}
}
