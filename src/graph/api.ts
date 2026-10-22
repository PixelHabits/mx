import { Schema, Struct } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api";
import { InstantFromString } from "../temporal.ts";

const EmailAddress = Schema.Struct({
	address: Schema.optionalKey(Schema.String),
	name: Schema.optionalKey(Schema.String),
});

export const Recipient = Schema.Struct({ emailAddress: EmailAddress });
export type Recipient = typeof Recipient.Type;

export const FlagStatus = Schema.Literals([
	"notFlagged",
	"flagged",
	"complete",
]);
export type FlagStatus = typeof FlagStatus.Type;

/** Every body mx reads is plain text: each request asks for it with `Prefer: outlook.body-content-type="text"`. */
const TextBody = Schema.Struct({
	content: Schema.String,
	contentType: Schema.Literal("text"),
});

/** The properties mx stores for a message, as `messageSelect` asks Graph for them. */
export const Message = Schema.Struct({
	bccRecipients: Schema.Array(Recipient),
	categories: Schema.Array(Schema.String),
	ccRecipients: Schema.Array(Recipient),
	conversationId: Schema.String,
	flag: Schema.Struct({ flagStatus: FlagStatus }),
	from: Schema.optionalKey(Schema.NullOr(Recipient)),
	hasAttachments: Schema.Boolean,
	id: Schema.String,
	importance: Schema.Literals(["low", "normal", "high"]),
	internetMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	isDraft: Schema.Boolean,
	isRead: Schema.Boolean,
	parentFolderId: Schema.String,
	receivedDateTime: Schema.NullOr(InstantFromString),
	sentDateTime: Schema.NullOr(InstantFromString),
	subject: Schema.NullOr(Schema.String),
	toRecipients: Schema.Array(Recipient),
	uniqueBody: TextBody,
});
export type Message = typeof Message.Type;

/** The `$select` that returns `Message`. */
export const messageSelect =
	"id,parentFolderId,conversationId,internetMessageId,from,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,sentDateTime,isRead,isDraft,flag,categories,importance,hasAttachments,uniqueBody";

/**
 * A delta entry for a message that left the folder, by deletion or by a move. Graph says `@removed` might carry a
 * reason (https://learn.microsoft.com/graph/delta-query-overview#resource-representation-in-the-delta-query-response).
 */
export const Removed = Schema.Struct({
	"@removed": Schema.Struct({ reason: Schema.optionalKey(Schema.String) }),
	id: Schema.String,
});

/**
 * A delta entry for a message that changed, with its id and at least the properties that changed, such as `isRead`
 * alone (https://learn.microsoft.com/graph/delta-query-overview#resource-representation-in-the-delta-query-response).
 * Each property it carries is checked as `Message` checks it.
 */
export class Changed extends Schema.Class<
	Changed,
	{ readonly brand: unique symbol }
>("Changed")(Message.mapFields(Struct.mapOmit(["id"], Schema.optionalKey))) {}

/**
 * One page of a folder's message delta: a next link while pages remain, then the delta link for the next round. An
 * entry with every property `messageSelect` asks for is a `Message`.
 */
export const DeltaPage = Schema.Struct({
	"@odata.deltaLink": Schema.optionalKey(Schema.String),
	"@odata.nextLink": Schema.optionalKey(Schema.String),
	value: Schema.Array(Schema.Union([Removed, Message, Changed])),
});
export type DeltaPage = typeof DeltaPage.Type;

/** One page of a folder's message ids, as a listing with `$select=id` answers them. */
export const IdPage = Schema.Struct({
	"@odata.nextLink": Schema.optionalKey(Schema.String),
	value: Schema.Array(Schema.Struct({ id: Schema.String })),
});

export const Folder = Schema.Struct({
	childFolderCount: Schema.Int,
	displayName: Schema.String,
	id: Schema.String,
	parentFolderId: Schema.String,
	/** Every item in the folder, read or not. */
	totalItemCount: Schema.Int,
});
export type Folder = typeof Folder.Type;

/** The `$select` that returns `Folder`. */
export const folderSelect =
	"id,displayName,parentFolderId,childFolderCount,totalItemCount";

/**
 * The names Graph gives the folders Outlook makes and keeps, whatever the mailbox's language
 * (https://learn.microsoft.com/graph/api/resources/mailfolder). A mailbox may lack some of them.
 */
export const wellKnownFolders = [
	"archive",
	"clutter",
	"conflicts",
	"conversationhistory",
	"deleteditems",
	"drafts",
	"inbox",
	"junkemail",
	"localfailures",
	"msgfolderroot",
	"outbox",
	"recoverableitemsdeletions",
	"scheduled",
	"searchfolders",
	"sentitems",
	"serverfailures",
	"syncissues",
] as const;

/** The one property mx writes on a folder it creates or renames. */
const FolderName = Schema.Struct({ displayName: Schema.String });

export const FolderPage = Schema.Struct({
	"@odata.nextLink": Schema.optionalKey(Schema.String),
	value: Schema.Array(Folder),
});

export const Attachment = Schema.Struct({
	"@odata.type": Schema.String,
	contentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	contentType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	id: Schema.String,
	isInline: Schema.Boolean,
	name: Schema.String,
	size: Schema.Int,
});
export type Attachment = typeof Attachment.Type;

/** A write's answer; mx reads the message back with `messageSelect`, since a write answers without `uniqueBody`. */
const Written = Schema.Struct({ id: Schema.String });

/** A body mx writes: HTML, since Outlook keeps a plain-text draft in plain text, where the user cannot format it. */
const Body = Schema.Struct({
	content: Schema.String,
	contentType: Schema.Literal("html"),
});

const params = { id: Schema.String };

/** A message mx writes: a draft it creates, or one `sendMail` sends. */
const NewMessage = Schema.Struct({
	bccRecipients: Schema.Array(Recipient),
	body: Body,
	ccRecipients: Schema.Array(Recipient),
	subject: Schema.String,
	toRecipients: Schema.Array(Recipient),
});

/** The body of a reply, reply-all or forward: the new HTML above the quoted message, and any properties to change. */
const Reaction = Schema.Struct({
	comment: Schema.String,
	message: Schema.optionalKey(
		Schema.Struct({
			bccRecipients: Schema.optionalKey(Schema.Array(Recipient)),
			ccRecipients: Schema.optionalKey(Schema.Array(Recipient)),
			subject: Schema.optionalKey(Schema.String),
			toRecipients: Schema.optionalKey(Schema.Array(Recipient)),
		})
	),
});
export type Reaction = typeof Reaction.Type;

/** Graph's error body: `{ error: { code, message } }`. */
export const GraphErrorBody = Schema.Struct({
	error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

/**
 * The Graph mail endpoints mx calls, under `https://graph.microsoft.com/v1.0`. Each declares only its success: a
 * refusal is read once, for every endpoint, by the client's response check.
 */
export const mail = HttpApiGroup.make("mail")
	.add(
		HttpApiEndpoint.get("folders", "/me/mailFolders", {
			query: { $select: Schema.String, $top: Schema.FiniteFromString },
			success: FolderPage,
		})
	)
	.add(
		HttpApiEndpoint.get("childFolders", "/me/mailFolders/:id/childFolders", {
			params,
			query: { $select: Schema.String, $top: Schema.FiniteFromString },
			success: FolderPage,
		})
	)
	.add(
		HttpApiEndpoint.get("folder", "/me/mailFolders/:id", {
			params,
			success: Folder,
		})
	)
	.add(
		HttpApiEndpoint.post("createFolder", "/me/mailFolders", {
			payload: FolderName,
			success: Folder.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.post(
			"createChildFolder",
			"/me/mailFolders/:id/childFolders",
			{
				params,
				payload: FolderName,
				success: Folder.pipe(HttpApiSchema.status(201)),
			}
		)
	)
	.add(
		HttpApiEndpoint.patch("renameFolder", "/me/mailFolders/:id", {
			params,
			payload: FolderName,
			success: Folder,
		})
	)
	.add(
		HttpApiEndpoint.post("moveFolder", "/me/mailFolders/:id/move", {
			params,
			payload: Schema.Struct({ destinationId: Schema.String }),
			// Graph answers a folder move with 201, although its docs say 200.
			success: Folder.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.get("delta", "/me/mailFolders/:id/messages/delta", {
			params,
			query: { $select: Schema.String },
			success: DeltaPage,
		})
	)
	.add(
		HttpApiEndpoint.get("messageIds", "/me/mailFolders/:id/messages", {
			params,
			query: { $select: Schema.Literal("id"), $top: Schema.FiniteFromString },
			success: IdPage,
		})
	)
	.add(
		HttpApiEndpoint.get("message", "/me/messages/:id", {
			params,
			query: { $select: Schema.String },
			success: Message,
		})
	)
	.add(
		HttpApiEndpoint.get("body", "/me/messages/:id", {
			params,
			query: { $select: Schema.Literal("body") },
			success: Schema.Struct({ body: TextBody }),
		})
	)
	.add(
		HttpApiEndpoint.patch("update", "/me/messages/:id", {
			params,
			payload: Schema.Struct({
				bccRecipients: Schema.optionalKey(Schema.Array(Recipient)),
				body: Schema.optionalKey(Body),
				categories: Schema.optionalKey(Schema.Array(Schema.String)),
				ccRecipients: Schema.optionalKey(Schema.Array(Recipient)),
				flag: Schema.optionalKey(Schema.Struct({ flagStatus: FlagStatus })),
				isRead: Schema.optionalKey(Schema.Boolean),
				subject: Schema.optionalKey(Schema.String),
				toRecipients: Schema.optionalKey(Schema.Array(Recipient)),
			}),
			success: Written,
		})
	)
	.add(
		HttpApiEndpoint.post("move", "/me/messages/:id/move", {
			params,
			payload: Schema.Struct({ destinationId: Schema.String }),
			success: Written.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.post("createReply", "/me/messages/:id/createReply", {
			params,
			payload: Reaction,
			success: Written.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.post("createReplyAll", "/me/messages/:id/createReplyAll", {
			params,
			payload: Reaction,
			success: Written.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.post("createForward", "/me/messages/:id/createForward", {
			params,
			payload: Reaction,
			success: Written.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.post("reply", "/me/messages/:id/reply", {
			params,
			payload: Reaction,
			success: HttpApiSchema.Accepted,
		})
	)
	.add(
		HttpApiEndpoint.post("replyAll", "/me/messages/:id/replyAll", {
			params,
			payload: Reaction,
			success: HttpApiSchema.Accepted,
		})
	)
	.add(
		HttpApiEndpoint.post("forward", "/me/messages/:id/forward", {
			params,
			payload: Reaction,
			success: HttpApiSchema.Accepted,
		})
	)
	.add(
		HttpApiEndpoint.post("send", "/me/messages/:id/send", {
			params,
			success: HttpApiSchema.Accepted,
		})
	)
	.add(
		HttpApiEndpoint.post("sendMail", "/me/sendMail", {
			payload: Schema.Struct({
				message: NewMessage,
				saveToSentItems: Schema.Boolean,
			}),
			success: HttpApiSchema.Accepted,
		})
	)
	.add(
		HttpApiEndpoint.post("createDraft", "/me/messages", {
			payload: NewMessage,
			success: Written.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.get("attachments", "/me/messages/:id/attachments", {
			params,
			success: Schema.Struct({ value: Schema.Array(Attachment) }),
		})
	)
	.add(
		HttpApiEndpoint.post("addAttachment", "/me/messages/:id/attachments", {
			params,
			payload: Schema.Struct({
				"@odata.type": Schema.Literal("#microsoft.graph.fileAttachment"),
				contentBytes: Schema.String,
				name: Schema.String,
			}),
			success: Written.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.post(
			"createUploadSession",
			"/me/messages/:id/attachments/createUploadSession",
			{
				params,
				payload: Schema.Struct({
					AttachmentItem: Schema.Struct({
						attachmentType: Schema.Literal("file"),
						name: Schema.String,
						size: Schema.Int,
					}),
				}),
				success: Schema.Struct({ uploadUrl: Schema.String }).pipe(
					HttpApiSchema.status(201)
				),
			}
		)
	);

export const Subscription = Schema.Struct({
	expirationDateTime: Schema.String,
	id: Schema.String,
	notificationUrl: Schema.String,
	resource: Schema.String,
});
export type Subscription = typeof Subscription.Type;

export const SubscriptionPage = Schema.Struct({
	"@odata.nextLink": Schema.optionalKey(Schema.String),
	value: Schema.Array(Subscription),
});

/** Graph change notifications: a subscription per folder that posts to a public URL. */
export const subscriptions = HttpApiGroup.make("subscriptions")
	.add(
		HttpApiEndpoint.get("list", "/subscriptions", {
			success: SubscriptionPage,
		})
	)
	.add(
		HttpApiEndpoint.post("create", "/subscriptions", {
			payload: Schema.Struct({
				changeType: Schema.String,
				clientState: Schema.String,
				expirationDateTime: Schema.String,
				lifecycleNotificationUrl: Schema.String,
				notificationUrl: Schema.String,
				resource: Schema.String,
			}),
			success: Subscription.pipe(HttpApiSchema.status(201)),
		})
	)
	.add(
		HttpApiEndpoint.patch("update", "/subscriptions/:id", {
			params,
			payload: Schema.Struct({ expirationDateTime: Schema.String }),
			success: Subscription,
		})
	)
	.add(
		HttpApiEndpoint.delete("delete", "/subscriptions/:id", {
			params,
			success: HttpApiSchema.NoContent,
		})
	)
	.add(
		HttpApiEndpoint.post("reauthorize", "/subscriptions/:id/reauthorize", {
			params,
			success: HttpApiSchema.NoContent,
		})
	);

export const GraphApi = HttpApi.make("Graph").add(mail).add(subscriptions);
