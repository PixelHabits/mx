import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect";
import { Base64 } from "effect/encoding";
import {
	HttpClient,
	type HttpClientError,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Auth } from "../auth/auth.ts";
import {
	type CredentialFailed,
	GraphRefused,
	GraphUnreadable,
	type LoginRequired,
	MicrosoftUnavailable,
} from "../errors.ts";
import { isRefusalStatus, policy } from "../http-policy.ts";
import {
	type Attachment,
	DeltaPage,
	type FlagStatus,
	type Folder,
	FolderPage,
	folderSelect,
	GraphApi,
	GraphErrorBody,
	IdPage,
	type Message,
	messageSelect,
	type Reaction,
	type Recipient,
	type Subscription,
	SubscriptionPage,
} from "./api.ts";

export type GraphError =
	| GraphRefused
	| MicrosoftUnavailable
	| LoginRequired
	| CredentialFailed;

const isGraphRefused = Schema.is(GraphRefused);

/** Graph's 404: the item the request names does not exist (https://learn.microsoft.com/graph/errors). */
export const isNotFound = (error: {
	readonly _tag: string;
}): error is GraphRefused => isGraphRefused(error) && error.status === 404;

/** Graph's refusal when the folder that would hold a new, renamed or moved folder already holds one of its name. */
export const isFolderExists = (error: {
	readonly _tag: string;
}): error is GraphRefused =>
	isGraphRefused(error) && error.code === "ErrorFolderExists";

const graphBase = "https://graph.microsoft.com/v1.0";

/** Plain-text bodies, and message ids that survive a move within the mailbox. */
const prefer = 'outlook.body-content-type="text", IdType="ImmutableId"';

/**
 * Up to 100 messages per delta page. Graph documents the preference for delta only
 * (https://learn.microsoft.com/graph/delta-query-messages#optional-request-header), so no other request sends it.
 */
const deltaPrefer = `${prefer}, odata.maxpagesize=100`;

/** Folders per page of a folder listing. */
const folderPageSize = 100;

/** Message ids per page of a folder's listing: `$top` takes 1 to 1000 (https://learn.microsoft.com/graph/api/user-list-messages). */
const idPageSize = 1000;

/** One page of a Graph collection. */
interface Page<A> {
	readonly "@odata.nextLink"?: string;
	readonly value: readonly A[];
}

/** Graph takes an attachment of up to 3 MB in one request; a larger one goes through an upload session. */
const singleRequestAttachmentLimit = 3 * 1024 * 1024;

/** Upload session chunks are multiples of 320 KiB and at most 4 MiB. */
const uploadChunkSize = 320 * 1024 * 12;

/** A Graph answer with a status other than 2xx: Graph's refusal when it explains one, otherwise unavailable. */
const checked = Effect.fnUntraced(function* (
	response: HttpClientResponse.HttpClientResponse
) {
	const { status } = response;
	if (status >= 200 && status < 300) {
		return response;
	}
	const body = yield* HttpClientResponse.schemaBodyJson(GraphErrorBody)(
		response
	).pipe(Effect.option);
	if (Option.isSome(body) && isRefusalStatus(status)) {
		return yield* GraphRefused.make({
			code: body.value.error.code,
			detail: body.value.error.message,
			status,
		});
	}
	const code = Option.getOrUndefined(
		Option.map(body, ({ error }) => error.code)
	);
	return yield* MicrosoftUnavailable.make({
		code,
		message: `Microsoft Graph answered ${status}${code === undefined ? "" : ` ${code}`}.`,
		reason: "answered",
		status,
	});
});

/**
 * The failure without its request, which carries the bearer token: the connection failed or ran out of time, or Graph
 * answered a status or body the endpoint does not declare.
 */
const unavailable = ({ reason }: HttpClientError.HttpClientError) => {
	if (reason._tag !== "TransportError") {
		const status = "response" in reason ? reason.response.status : undefined;
		return MicrosoftUnavailable.make({
			message: `Microsoft Graph answered${status === undefined ? "" : ` ${status}`} in a form mx does not read (${reason._tag}).`,
			reason: "answered",
			status,
		});
	}
	const deadline = reason.description === "deadline";
	return MicrosoftUnavailable.make({
		cause: reason.cause,
		message: deadline
			? "Microsoft Graph did not answer before the deadline."
			: "Microsoft Graph could not be reached.",
		reason: deadline ? "deadline" : "transport",
	});
};

/** Narrows a request's failures to mx's errors, and an answer that does not match its schema as `unmatched` says. */
const settleWith =
	<E>(unmatched: (error: Schema.SchemaError) => Effect.Effect<never, E>) =>
	<A>(
		effect: Effect.Effect<
			A,
			GraphError | HttpClientError.HttpClientError | Schema.SchemaError
		>
	): Effect.Effect<A, GraphError | E> =>
		Effect.catchTags(effect, {
			HttpClientError: (error) => Effect.fail(unavailable(error)),
			SchemaError: unmatched,
		});

/** An answer that does not match its schema is a defect. */
const settle = settleWith(Effect.die);

/**
 * A page of a folder's messages that does not match its schema fails with `GraphUnreadable`, so a pass or a check skips
 * that folder and goes on with the others.
 */
const settlePage = settleWith((error) =>
	Effect.fail(GraphUnreadable.make({ issue: error.message }))
);

const recipients = (addresses: readonly string[]): readonly Recipient[] =>
	Arr.map(addresses, (address) => ({ emailAddress: { address } }));

/** Who a message goes to and what it says. A field left out keeps what Graph fills in: nothing on a new message, the quoted message's on a reply or forward. */
export interface Fields {
	readonly bcc?: readonly string[] | undefined;
	readonly cc?: readonly string[] | undefined;
	readonly html?: string | undefined;
	readonly subject?: string | undefined;
	readonly to?: readonly string[] | undefined;
}

/** A message to draft or send: a new one, or a reply, reply-all or forward of message `id` that quotes it below `html`. */
export type Compose = Fields &
	(
		| { readonly kind: "new" }
		| {
				readonly id: string;
				readonly kind: "reply" | "reply_all" | "forward";
		  }
	);

const newMessage = (fields: Fields) => ({
	bccRecipients: recipients(fields.bcc ?? []),
	body: { content: fields.html ?? "", contentType: "html" as const },
	ccRecipients: recipients(fields.cc ?? []),
	subject: fields.subject ?? "",
	toRecipients: recipients(fields.to ?? []),
});

const reaction = ({ bcc, cc, html, subject, to }: Fields): Reaction => ({
	comment: html ?? "",
	...(Arr.every([to, cc, bcc, subject], (field) => field === undefined)
		? {}
		: {
				message: {
					...(to === undefined ? {} : { toRecipients: recipients(to) }),
					...(cc === undefined ? {} : { ccRecipients: recipients(cc) }),
					...(bcc === undefined ? {} : { bccRecipients: recipients(bcc) }),
					...(subject === undefined ? {} : { subject }),
				},
			}),
});

/**
 * Microsoft Graph for the signed-in mailbox. Every request asks for text bodies and immutable ids, and every body mx
 * writes is HTML. Reads retry transient failures and writes retry only Graph's 429, each waiting at least as long as
 * `Retry-After` asks; the policy in `http-policy.ts` owns both. A write answers no more than the id of the message it
 * wrote: Graph answers a write without `uniqueBody`, so `message` reads the message back where a caller needs it.
 */
export class Graph extends Context.Service<
	Graph,
	{
		/** Every mail folder, each parent before its children. */
		readonly folders: Effect.Effect<readonly Folder[], GraphError>;
		readonly folder: (idOrName: string) => Effect.Effect<Folder, GraphError>;
		/** Creates a folder named `name` below the folder `parentId`, or at the top of the mailbox. */
		readonly createFolder: (
			parentId: Option.Option<string>,
			name: string
		) => Effect.Effect<Folder, GraphError>;
		readonly renameFolder: (
			id: string,
			name: string
		) => Effect.Effect<Folder, GraphError>;
		/**
		 * Moves the folder, with the folders and messages in it, below a folder id or a well-known folder name such as
		 * `deleteditems`.
		 */
		readonly moveFolder: (
			id: string,
			destination: string
		) => Effect.Effect<Folder, GraphError>;
		/** The ids of every message in the folder. */
		readonly messageIds: (
			folderId: string
		) => Effect.Effect<readonly string[], GraphError | GraphUnreadable>;
		/** The folder's first delta page, or the page at a next or delta link Graph gave before. */
		readonly delta: (
			folderId: string,
			link: Option.Option<string>
		) => Effect.Effect<DeltaPage, GraphError | GraphUnreadable>;
		readonly message: (id: string) => Effect.Effect<Message, GraphError>;
		/** The whole body as text, quoted history included. */
		readonly body: (id: string) => Effect.Effect<string, GraphError>;
		readonly attachments: (
			id: string
		) => Effect.Effect<readonly Attachment[], GraphError>;
		readonly attachmentContent: (
			id: string,
			attachmentId: string
		) => Effect.Effect<Uint8Array, GraphError>;
		readonly update: (
			id: string,
			patch: {
				readonly bcc?: readonly string[];
				readonly cc?: readonly string[];
				readonly categories?: readonly string[];
				readonly flag?: FlagStatus;
				readonly html?: string;
				readonly isRead?: boolean;
				readonly subject?: string;
				readonly to?: readonly string[];
			}
		) => Effect.Effect<void, GraphError>;
		/** Moves the message to a folder id or a well-known folder name such as `deleteditems`, and answers its id. */
		readonly move: (
			id: string,
			destination: string
		) => Effect.Effect<string, GraphError>;
		/**
		 * Creates a draft in Drafts and answers its id; a reply, reply-all or forward quotes the conversation below its
		 * `html`.
		 */
		readonly draft: (compose: Compose) => Effect.Effect<string, GraphError>;
		/** Sends at once through `sendMail`, or the reply, reply-all or forward action, which quotes as a draft does. */
		readonly send: (compose: Compose) => Effect.Effect<void, GraphError>;
		readonly sendDraft: (id: string) => Effect.Effect<void, GraphError>;
		readonly attach: (input: {
			readonly bytes: Uint8Array;
			readonly id: string;
			readonly name: string;
		}) => Effect.Effect<void, GraphError>;
		/** This app's subscriptions for the signed-in user. */
		readonly subscriptions: Effect.Effect<readonly Subscription[], GraphError>;
		readonly subscribe: (input: {
			readonly changeType: string;
			readonly clientState: string;
			readonly expiration: Temporal.Instant;
			readonly lifecycleNotificationUrl: string;
			readonly notificationUrl: string;
			readonly resource: string;
		}) => Effect.Effect<Subscription, GraphError>;
		/** Renews a subscription until `expiration`. */
		readonly renew: (
			id: string,
			expiration: Temporal.Instant
		) => Effect.Effect<Subscription, GraphError>;
		readonly unsubscribe: (id: string) => Effect.Effect<void, GraphError>;
		readonly reauthorize: (id: string) => Effect.Effect<void, GraphError>;
	}
>()("mx/graph/graph") {
	static readonly layerNoDeps = Layer.effect(
		Graph,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const transport = policy(yield* HttpClient.HttpClient);
			const preferring = (preference: string) =>
				auth
					.authorize(
						transport.pipe(
							HttpClient.mapRequest(
								HttpClientRequest.setHeader("prefer", preference)
							)
						)
					)
					.pipe(HttpClient.transformResponse(Effect.flatMap(checked)));
			const client = preferring(prefer);
			const deltaClient = preferring(deltaPrefer);
			/** Upload URLs carry their own authorization and refuse a bearer token. */
			const uploads = transport.pipe(
				HttpClient.transformResponse(Effect.flatMap(checked))
			);
			const { mail, subscriptions: subscriptionApi } =
				yield* HttpApiClient.makeWith(GraphApi, {
					baseUrl: graphBase,
					httpClient: client,
				});

			const firstDelta = yield* HttpApiClient.endpoint(GraphApi, {
				baseUrl: graphBase,
				endpoint: "delta",
				group: "mail",
				httpClient: deltaClient,
			});

			const getJsonFrom =
				(http: typeof client) =>
				<S extends Schema.Top>(url: string, schema: S) =>
					http
						.get(url)
						.pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)));
			const getJson = getJsonFrom(client);

			/** Every item of a collection: its first page, then the page `next` reads at each `@odata.nextLink`. */
			const everyPage = <A, E>(
				first: Effect.Effect<Page<A>, E>,
				next: (url: string) => Effect.Effect<Page<A>, E>
			) =>
				Effect.gen(function* () {
					let page = yield* first;
					const found: A[] = [...page.value];
					while (page["@odata.nextLink"] !== undefined) {
						page = yield* next(page["@odata.nextLink"]);
						found.push(...page.value);
					}
					return found;
				});

			const message = (id: string) =>
				settle(
					mail.message({ params: { id }, query: { $select: messageSelect } })
				);

			const listFolders = (
				first: Effect.Effect<typeof FolderPage.Type, GraphError>
			): Effect.Effect<readonly Folder[], GraphError> =>
				Effect.gen(function* () {
					const found = yield* everyPage(first, (url) =>
						settle(getJson(url, FolderPage))
					);
					const nested = yield* Effect.forEach(found, (parent) =>
						parent.childFolderCount === 0
							? Effect.succeed([parent])
							: mail
									.childFolders({
										params: { id: parent.id },
										query: { $select: folderSelect, $top: folderPageSize },
									})
									.pipe(
										settle,
										listFolders,
										Effect.map((children) => [parent, ...children])
									)
					);
					return Arr.flatten(nested);
				});

			const folders = mail
				.folders({ query: { $select: folderSelect, $top: folderPageSize } })
				.pipe(settle, listFolders, Effect.withSpan("Graph.folders"));

			const folder = Effect.fn("Graph.folder")((idOrName: string) =>
				settle(mail.folder({ params: { id: idOrName } }))
			);

			const createFolder = Effect.fn("Graph.createFolder")(
				(parentId: Option.Option<string>, name: string) =>
					settle(
						Option.match(parentId, {
							onNone: () =>
								mail.createFolder({ payload: { displayName: name } }),
							onSome: (id) =>
								mail.createChildFolder({
									params: { id },
									payload: { displayName: name },
								}),
						})
					)
			);

			const renameFolder = Effect.fn("Graph.renameFolder")(
				(id: string, name: string) =>
					settle(
						mail.renameFolder({
							params: { id },
							payload: { displayName: name },
						})
					)
			);

			const moveFolder = Effect.fn("Graph.moveFolder")(
				(id: string, destination: string) =>
					settle(
						mail.moveFolder({
							params: { id },
							payload: { destinationId: destination },
						})
					)
			);

			const messageIds = Effect.fn("Graph.messageIds")(function* (
				folderId: string
			) {
				const found = yield* everyPage(
					settlePage(
						mail.messageIds({
							params: { id: folderId },
							query: { $select: "id", $top: idPageSize },
						})
					),
					(url) => settlePage(getJson(url, IdPage))
				);
				return Arr.map(found, ({ id }) => id);
			});

			const delta = Effect.fn("Graph.delta")(
				(folderId: string, link: Option.Option<string>) =>
					Option.match(link, {
						onNone: () =>
							settlePage(
								firstDelta({
									params: { id: folderId },
									query: { $select: messageSelect },
								})
							),
						onSome: (url) =>
							settlePage(getJsonFrom(deltaClient)(url, DeltaPage)),
					})
			);

			const body = Effect.fn("Graph.body")(function* (id: string) {
				const { body: text } = yield* settle(
					mail.body({ params: { id }, query: { $select: "body" } })
				);
				return text.content;
			});

			const attachments = Effect.fn("Graph.attachments")(function* (
				id: string
			) {
				const { value } = yield* settle(mail.attachments({ params: { id } }));
				return value;
			});

			const attachmentContent = Effect.fn("Graph.attachmentContent")(
				(id: string, attachmentId: string) =>
					settle(
						client
							.get(
								`${graphBase}/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/$value`
							)
							.pipe(
								Effect.flatMap((response) => response.arrayBuffer),
								Effect.map((buffer) => new Uint8Array(buffer))
							)
					)
			);

			const update: Graph["Service"]["update"] = Effect.fn("Graph.update")(
				function* (id, patch) {
					yield* settle(
						mail.update({
							params: { id },
							payload: {
								...(patch.isRead === undefined ? {} : { isRead: patch.isRead }),
								...(patch.flag === undefined
									? {}
									: { flag: { flagStatus: patch.flag } }),
								...(patch.categories === undefined
									? {}
									: { categories: patch.categories }),
								...(patch.subject === undefined
									? {}
									: { subject: patch.subject }),
								...(patch.html === undefined
									? {}
									: { body: { content: patch.html, contentType: "html" } }),
								...(patch.to === undefined
									? {}
									: { toRecipients: recipients(patch.to) }),
								...(patch.cc === undefined
									? {}
									: { ccRecipients: recipients(patch.cc) }),
								...(patch.bcc === undefined
									? {}
									: { bccRecipients: recipients(patch.bcc) }),
							},
						})
					);
				}
			);

			const move = Effect.fn("Graph.move")(function* (
				id: string,
				destination: string
			) {
				const moved = yield* settle(
					mail.move({ params: { id }, payload: { destinationId: destination } })
				);
				return moved.id;
			});

			const reactions = {
				forward: { create: mail.createForward, send: mail.forward },
				reply: { create: mail.createReply, send: mail.reply },
				reply_all: { create: mail.createReplyAll, send: mail.replyAll },
			};

			const draft = Effect.fn("Graph.draft")(function* (compose: Compose) {
				const drafted = yield* settle(
					compose.kind === "new"
						? mail.createDraft({ payload: newMessage(compose) })
						: reactions[compose.kind].create({
								params: { id: compose.id },
								payload: reaction(compose),
							})
				);
				return drafted.id;
			});

			const send = Effect.fn("Graph.send")((compose: Compose) =>
				settle(
					compose.kind === "new"
						? mail.sendMail({
								payload: {
									message: newMessage(compose),
									saveToSentItems: true,
								},
							})
						: reactions[compose.kind].send({
								params: { id: compose.id },
								payload: reaction(compose),
							})
				)
			);

			const sendDraft = Effect.fn("Graph.sendDraft")((id: string) =>
				settle(mail.send({ params: { id } }))
			);

			const attach: Graph["Service"]["attach"] = Effect.fn("Graph.attach")(
				function* ({ bytes, id, name }) {
					if (bytes.length <= singleRequestAttachmentLimit) {
						yield* settle(
							mail.addAttachment({
								params: { id },
								payload: {
									"@odata.type": "#microsoft.graph.fileAttachment",
									contentBytes: Base64.encode(bytes),
									name,
								},
							})
						);
						return;
					}
					const { uploadUrl } = yield* settle(
						mail.createUploadSession({
							params: { id },
							payload: {
								AttachmentItem: {
									attachmentType: "file",
									name,
									size: bytes.length,
								},
							},
						})
					);
					for (let start = 0; start < bytes.length; start += uploadChunkSize) {
						const chunk = bytes.subarray(start, start + uploadChunkSize);
						yield* settle(
							uploads.execute(
								HttpClientRequest.put(uploadUrl).pipe(
									HttpClientRequest.setHeader(
										"content-range",
										`bytes ${start}-${start + chunk.length - 1}/${bytes.length}`
									),
									HttpClientRequest.bodyUint8Array(
										chunk,
										"application/octet-stream"
									)
								)
							)
						);
					}
				}
			);

			const subscriptions = everyPage(settle(subscriptionApi.list()), (url) =>
				settle(getJson(url, SubscriptionPage))
			).pipe(Effect.withSpan("Graph.subscriptions"));

			const subscribe: Graph["Service"]["subscribe"] = Effect.fn(
				"Graph.subscribe"
			)(({ expiration, ...input }) =>
				settle(
					subscriptionApi.create({
						payload: { ...input, expirationDateTime: expiration.toString() },
					})
				)
			);

			const renew = Effect.fn("Graph.renew")(
				(id: string, expiration: Temporal.Instant) =>
					settle(
						subscriptionApi.update({
							params: { id },
							payload: { expirationDateTime: expiration.toString() },
						})
					)
			);

			const unsubscribe = Effect.fn("Graph.unsubscribe")((id: string) =>
				settle(subscriptionApi.delete({ params: { id } }))
			);

			const reauthorize = Effect.fn("Graph.reauthorize")((id: string) =>
				settle(subscriptionApi.reauthorize({ params: { id } }))
			);

			return Graph.of({
				attach,
				attachmentContent,
				attachments,
				body,
				createFolder,
				delta,
				draft,
				folder,
				folders,
				message: Effect.fn("Graph.message")(message),
				messageIds,
				move,
				moveFolder,
				reauthorize,
				renameFolder,
				renew,
				send,
				sendDraft,
				subscribe,
				subscriptions,
				unsubscribe,
				update,
			});
		})
	);

	static readonly layer = Graph.layerNoDeps.pipe(Layer.provide(Auth.layer));
}
