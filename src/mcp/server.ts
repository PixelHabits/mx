import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Result,
	Schema,
} from "effect";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/ai";
import {
	type CredentialFailed,
	type GraphRefused,
	type LoginRequired,
	type MicrosoftUnavailable,
	NotFound,
	Refused,
} from "../errors.ts";
import { FlagStatus, type Message, type Recipient } from "../graph/api.ts";
import { type Compose, Graph } from "../graph/graph.ts";
import { Paths } from "../paths.ts";
import { Store, type Stored, type StoredFolder } from "../store.ts";
import { PlainDateFromString } from "../temporal.ts";
import {
	attachmentList,
	inBodyOrder,
	line,
	listing,
	messageText,
	threadText,
} from "./format.ts";

/** What a tool fails with; the agent reads its message. */
type ToolError =
	| NotFound
	| Refused
	| GraphRefused
	| MicrosoftUnavailable
	| LoginRequired
	| CredentialFailed;

/** The listing size when the agent names none, and the most one search returns. */
const defaultLimit = 20;
const maxLimit = 200;

const Id = Schema.Int.annotate({
	description: "A message's local id: the number after # in a listing.",
});
const Ids = Schema.Array(Id).annotate({
	description: "Local ids of the messages.",
});
const Addresses = Schema.Array(Schema.String).annotate({
	description: "Email addresses.",
});
const Files = Schema.Array(Schema.String).annotate({
	description: "Paths of local files to attach.",
});

/** The fields that make a message, shared by `draft` and an inline `send`. */
const composeFields = {
	attach: Schema.optionalKey(Files),
	bcc: Schema.optionalKey(Addresses),
	body: Schema.optionalKey(
		Schema.String.annotate({
			description:
				"Plain text. A reply or forward puts it above the quoted conversation.",
		})
	),
	cc: Schema.optionalKey(Addresses),
	kind: Schema.Literals(["new", "reply", "reply_all", "forward"]).annotate({
		description:
			"new, or reply, reply_all or forward, which quote the conversation of message.",
	}),
	message: Schema.optionalKey(
		Id.annotate({
			description:
				"The local id of the message to reply to or forward. Required unless kind is new.",
		})
	),
	subject: Schema.optionalKey(Schema.String),
	to: Schema.optionalKey(Addresses),
};
const ComposeInput = Schema.Struct(composeFields);
type ComposeInput = typeof ComposeInput.Type;

const SendDraft = Schema.Struct({
	bcc: Addresses,
	cc: Addresses,
	draft: Id,
	subject: Schema.String,
	to: Addresses,
});

/** The same addresses in any order and case. */
const sameAddresses = (a: readonly string[], b: readonly string[]) => {
	const key = (list: readonly string[]) =>
		Arr.join(
			Arr.sort(
				Arr.map(list, (address) => address.toLowerCase()),
				Order.String
			),
			"\n"
		);
	return key(a) === key(b);
};

/** Every recipient: `a, b; cc c; bcc d`, or `nobody`. */
const recipientsText = ({
	bcc,
	cc,
	to,
}: {
	readonly bcc: readonly string[];
	readonly cc: readonly string[];
	readonly to: readonly string[];
}) =>
	Arr.join(
		Arr.filter(
			[
				Arr.join(to, ", "),
				cc.length === 0 ? "" : `cc ${Arr.join(cc, ", ")}`,
				bcc.length === 0 ? "" : `bcc ${Arr.join(bcc, ", ")}`,
			],
			(part) => part !== ""
		),
		"; "
	) || "nobody";

const addressesOf = (list: readonly Recipient[]) =>
	Arr.map(list, ({ emailAddress }) => emailAddress.address ?? "");

/** `send`'s two shapes; a call with a field of the other shape matches neither. */
const decodeSend = Schema.decodeUnknownEffect(
	Schema.Union([SendDraft, ComposeInput]),
	{ onExcessProperty: "error" }
);

const search = Tool.make("search", {
	description:
		"Search the local copy of the mailbox. query matches words in the subject, the sender and the message's new text; every filter is optional, and without a query the newest messages are listed. Answers one line per message, newest first: #id date folder | sender | subject | markers.",
	parameters: Schema.Struct({
		folder: Schema.optionalKey(
			Schema.String.annotate({
				description: "A folder name or path, such as Inbox or Inbox/Projects.",
			})
		),
		from: Schema.optionalKey(
			Schema.String.annotate({
				description: "Part of the sender's name or address.",
			})
		),
		limit: Schema.optionalKey(
			Schema.Int.check(
				Schema.isBetween({ maximum: maxLimit, minimum: 1 })
			).annotate({
				description: `How many messages to list, ${defaultLimit} unless given.`,
			})
		),
		query: Schema.optionalKey(Schema.String),
		since: Schema.optionalKey(
			PlainDateFromString.annotate({
				description: "Only messages from this date on, as YYYY-MM-DD.",
			})
		),
	}),
})
	.annotate(Tool.Readonly, true)
	.annotate(Tool.Destructive, false)
	.annotate(Tool.OpenWorld, false);

const thread = Tool.make("thread", {
	description:
		"The whole conversation a message belongs to, across every folder, oldest first: headers and each message's new text. The signed-in user's own messages say (me).",
	parameters: Schema.Struct({ id: Id }),
})
	.annotate(Tool.Readonly, true)
	.annotate(Tool.Destructive, false)
	.annotate(Tool.OpenWorld, false);

const message = Tool.make("message", {
	description:
		"One message's headers and new text. full=true fetches the whole body from Graph, quoted history included.",
	parameters: Schema.Struct({
		full: Schema.optionalKey(Schema.Boolean),
		id: Id,
	}),
})
	.annotate(Tool.Readonly, true)
	.annotate(Tool.Destructive, false)
	.annotate(Tool.OpenWorld, false);

const attachment = Tool.make("attachment", {
	description:
		"Without n, lists a message's attachments, inline images included, numbered in the order the body shows them; [img N] in a body is attachment N. With n, saves attachment n to the cache folder and answers the file's path.",
	parameters: Schema.Struct({
		id: Id,
		n: Schema.optionalKey(Schema.Int),
	}),
})
	.annotate(Tool.Readonly, true)
	.annotate(Tool.Destructive, false)
	.annotate(Tool.OpenWorld, false);

const draft = Tool.make("draft", {
	description:
		"Creates a draft in Drafts and answers its listing line with its local id. A reply, reply_all or forward quotes the conversation below body and starts with the recipients and subject Outlook would give it; to, cc, bcc and subject replace those. Nothing is sent.",
	parameters: ComposeInput,
})
	.annotate(Tool.Destructive, false)
	.annotate(Tool.OpenWorld, false);

const updateDraft = Tool.make("update_draft", {
	description:
		"Changes a draft. body replaces the whole body, quoted conversation included; to, cc and bcc replace the recipients; attach adds files. Refuses any message that is not a draft.",
	parameters: Schema.Struct({
		attach: Schema.optionalKey(Files),
		bcc: Schema.optionalKey(Addresses),
		body: Schema.optionalKey(Schema.String),
		cc: Schema.optionalKey(Addresses),
		id: Id,
		subject: Schema.optionalKey(Schema.String),
		to: Schema.optionalKey(Addresses),
	}),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, false);

const deleteDraft = Tool.make("delete_draft", {
	description:
		"Moves a draft to Deleted Items. Refuses any message that is not a draft.",
	parameters: Schema.Struct({ id: Id }),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, false);

const send = Tool.make("send", {
	description:
		"Sends mail. Either send a draft with { draft, to, cc, bcc, subject }, where to, cc, bcc and subject repeat the draft's current values, an empty list where it has none; recipients may differ in order and case, and any other mismatch sends nothing. Or send a message at once with the fields of draft: kind, message, to, cc, bcc, subject, body and attach.",
	parameters: Schema.Struct({
		...composeFields,
		draft: Schema.optionalKey(
			Id.annotate({ description: "The local id of the draft to send." })
		),
		kind: Schema.optionalKey(composeFields.kind),
	}),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, true);

const update = Tool.make("update", {
	description:
		"Changes messages: read marks them read or unread, flag sets the follow-up flag (notFlagged clears it), categories replaces their categories (an empty list clears them), and move_to moves them to a folder named as in search, other than Deleted Items and the folders in it, where only delete moves them.",
	parameters: Schema.Struct({
		categories: Schema.optionalKey(Schema.Array(Schema.String)),
		flag: Schema.optionalKey(FlagStatus),
		ids: Ids,
		move_to: Schema.optionalKey(Schema.String),
		read: Schema.optionalKey(Schema.Boolean),
	}),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, false);

const deleteMessages = Tool.make("delete", {
	description:
		"Moves messages to Deleted Items, where Outlook can restore them.",
	parameters: Schema.Struct({ ids: Ids }),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, false);

const textResult = (text: string, isError: boolean) =>
	McpSchema.CallToolResult.make({
		content: [{ text, type: "text" }],
		isError,
	});

/**
 * Registers `tool` with a handler that answers plain text. `McpServer.toolkit` would answer every result as JSON and
 * repeat it as structured content, which Claude Code shows the model in place of the text.
 */
const register = Effect.fnUntraced(function* <
	P extends Schema.Top & { readonly DecodingServices: never },
>(
	tool: Tool.Tool<
		string,
		{
			readonly failure: Schema.Top;
			readonly failureMode: Tool.FailureMode;
			readonly parameters: P;
			readonly success: Schema.Top;
		}
	>,
	run: (params: P["Type"]) => Effect.Effect<string, ToolError>
) {
	const server = yield* McpServer.McpServer;
	const decode = Schema.decodeUnknownEffect(tool.parametersSchema);
	yield* server.addTool({
		annotations: tool.annotations,
		handle: (payload: unknown) =>
			decode(payload ?? {}).pipe(
				Effect.mapError((error) =>
					McpSchema.InvalidParams.make({ message: error.message })
				),
				Effect.flatMap((params) =>
					run(params).pipe(
						Effect.match({
							onFailure: (error) => textResult(error.message, true),
							onSuccess: (text) => textResult(text, false),
						})
					)
				)
			),
		tool: McpSchema.Tool.make({
			annotations: {
				destructiveHint: Context.get(tool.annotations, Tool.Destructive),
				idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
				openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
				readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
			},
			description: Tool.getDescription(tool),
			inputSchema: Tool.getJsonSchema(tool),
			name: tool.name,
		}),
	});
});

const unsafeInFileName = /[/\\\0]/gu;
const leadingDots = /^\.+/u;

/** An attachment name safe to write in the cache: no directory parts and no leading dot. */
const fileName = (name: string) =>
	name.replaceAll(unsafeInFileName, "_").replace(leadingDots, "_") ||
	"attachment";

/** The MCP tools, registered on the `McpServer` in context. Reads answer from the store; writes go to Graph first. */
export const tools = Layer.effectDiscard(
	Effect.gen(function* () {
		const store = yield* Store;
		const graph = yield* Graph;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const { cache } = yield* Paths;

		const stored = Effect.fnUntraced(function* (id: number) {
			const found = yield* store.byId(id);
			if (Option.isNone(found)) {
				return yield* NotFound.make({
					message: `No message #${id}. It may have been moved out of reach or deleted; search again.`,
				});
			}
			return found.value;
		});

		/** The message as Graph holds it now, refused unless it is still a draft. */
		const currentDraft = Effect.fnUntraced(function* (id: number) {
			const current = yield* graph.message((yield* stored(id)).graphId);
			if (!current.isDraft) {
				return yield* Refused.make({ message: `#${id} is not a draft.` });
			}
			return current;
		});

		/**
		 * Saves Graph's copy of a message after a write and answers its listing line. A folder the store does not know yet,
		 * as before the first sync, is added from Graph first.
		 */
		const savedLine = Effect.fnUntraced(function* (written: Message) {
			if (!(yield* store.hasFolder(written.parentFolderId))) {
				const [folder, sentItems] = yield* Effect.all(
					[graph.folder(written.parentFolderId), graph.folder("sentitems")],
					{ concurrency: 2 }
				);
				yield* store.saveFolder(folder, folder.id === sentItems.id);
			}
			return line(yield* stored(yield* store.save(written)));
		});

		const folderNamed = Effect.fnUntraced(function* (name: string) {
			const wanted = name.toLowerCase();
			const folders = yield* store.folders;
			const byPath = Arr.filter(
				folders,
				(folder) => folder.path.toLowerCase() === wanted
			);
			const matches =
				byPath.length > 0
					? byPath
					: Arr.filter(
							folders,
							(folder) => folder.name.toLowerCase() === wanted
						);
			const [first, ...others] = matches;
			if (first === undefined) {
				return yield* NotFound.make({ message: `No folder named ${name}.` });
			}
			if (others.length > 0) {
				return yield* Refused.make({
					message: `${name} names ${Arr.join(
						Arr.map(matches, (folder) => folder.path),
						", "
					)}; give the path.`,
				});
			}
			return first;
		});

		/** Whether `folder` is Deleted Items or a folder inside it, where mail goes only through `delete`, which the client asks about. */
		const inDeletedItems = Effect.fnUntraced(function* (folder: StoredFolder) {
			const { id } = yield* graph.folder("deleteditems");
			return Arr.some(
				yield* store.folders,
				(deleted) =>
					deleted.id === id && `${folder.path}/`.startsWith(`${deleted.path}/`)
			);
		});

		const numbered = Effect.fnUntraced(function* (found: Stored) {
			const [list, body] = yield* Effect.all(
				[graph.attachments(found.graphId), graph.body(found.graphId)],
				{ concurrency: 2 }
			);
			return inBodyOrder(list, body);
		});

		/** Reads every file before any write, so a bad path changes nothing in the mailbox. */
		const readFiles = (paths: readonly string[]) =>
			Effect.forEach(paths, (file) =>
				fs.readFile(file).pipe(
					Effect.map((bytes) => ({ bytes, name: path.basename(file) })),
					Effect.catchTag("PlatformError", (error) =>
						NotFound.make({ message: `Cannot read ${file}: ${error.message}` })
					)
				)
			);

		const attachFiles = Effect.fnUntraced(function* (
			target: Message,
			files: readonly { readonly bytes: Uint8Array; readonly name: string }[]
		) {
			let current = target;
			for (const file of files) {
				current = yield* graph.attach({ ...file, id: target.id });
			}
			return current;
		});

		const composed = Effect.fnUntraced(function* (input: ComposeInput) {
			const fields = {
				bcc: input.bcc,
				cc: input.cc,
				subject: input.subject,
				text: input.body,
				to: input.to,
			};
			if (input.kind === "new") {
				if (input.message !== undefined) {
					return yield* Refused.make({
						message: "kind new answers no message; leave message out.",
					});
				}
				return { ...fields, kind: input.kind } satisfies Compose;
			}
			if (input.message === undefined) {
				return yield* Refused.make({
					message: `kind ${input.kind} needs message, the local id of the message it answers.`,
				});
			}
			const found = yield* stored(input.message);
			return {
				...fields,
				id: found.graphId,
				kind: input.kind,
			} satisfies Compose;
		});

		/** A new draft with its files attached. */
		const drafted = Effect.fnUntraced(function* (input: ComposeInput) {
			const compose = yield* composed(input);
			const files = yield* readFiles(input.attach ?? []);
			return yield* attachFiles(yield* graph.draft(compose), files);
		});

		/**
		 * Sends a draft only when `to`, `cc`, `bcc` and `subject` repeat its own, so the client's approval prompt shows
		 * everyone it goes to. Graph sends the draft as it stands, so each of them counts.
		 */
		const sendDraft = Effect.fnUntraced(function* ({
			draft: id,
			subject,
			...repeated
		}: typeof SendDraft.Type) {
			const current = yield* currentDraft(id);
			const actual = {
				bcc: addressesOf(current.bccRecipients),
				cc: addressesOf(current.ccRecipients),
				to: addressesOf(current.toRecipients),
			};
			const actualSubject = current.subject ?? "";
			if (
				actualSubject !== subject ||
				!Arr.every(["to", "cc", "bcc"] as const, (field) =>
					sameAddresses(actual[field], repeated[field])
				)
			) {
				return yield* Refused.make({
					message: `Nothing was sent: #${id} goes to ${recipientsText(actual)} with the subject "${actualSubject}". Repeat to, cc, bcc and subject exactly to send it.`,
				});
			}
			yield* graph.sendDraft(current.id);
			yield* store.remove(current.id, current.parentFolderId);
			return `Sent #${id} to ${recipientsText(actual)}: ${actualSubject || "(no subject)"}`;
		});

		/** Sends in one request, or through a draft when files go with it, since only a draft takes attachments. */
		const sendNow = Effect.fnUntraced(function* (input: ComposeInput) {
			const compose = yield* composed(input);
			const files = yield* readFiles(input.attach ?? []);
			if (Arr.isReadonlyArrayNonEmpty(files)) {
				const withFiles = yield* attachFiles(
					yield* graph.draft(compose),
					files
				);
				yield* graph.sendDraft(withFiles.id);
			} else {
				yield* graph.send(compose);
			}
			return input.kind === "new"
				? `Sent to ${recipientsText({ bcc: input.bcc ?? [], cc: input.cc ?? [], to: input.to ?? [] })}: ${input.subject || "(no subject)"}`
				: `Sent the ${input.kind.replace("_", "-")} to #${input.message}.`;
		});

		/** Runs `one` for each id and answers a line per id; any failure makes the whole answer an error. */
		const each = Effect.fnUntraced(function* (
			ids: readonly number[],
			one: (id: number) => Effect.Effect<string, ToolError>
		) {
			const results = yield* Effect.forEach(ids, (id) =>
				Effect.result(one(id)).pipe(
					Effect.map(Result.mapError((error) => `#${id}: ${error.message}`))
				)
			);
			const answer = Arr.join(
				Arr.map(results, (result) =>
					Result.isSuccess(result) ? result.success : result.failure
				),
				"\n"
			);
			if (Arr.some(results, Result.isFailure)) {
				return yield* Refused.make({ message: answer });
			}
			return answer;
		});

		yield* register(search, (params) =>
			Effect.gen(function* () {
				const folder = yield* Effect.transposeOption(
					Option.map(Option.fromUndefinedOr(params.folder), (name) =>
						Effect.map(folderNamed(name), ({ id }) => id)
					)
				);
				const found = yield* store.search({
					folderId: folder,
					from: Option.fromUndefinedOr(params.from),
					limit: params.limit ?? defaultLimit,
					since: Option.map(Option.fromUndefinedOr(params.since), (day) =>
						day.toZonedDateTime(Temporal.Now.timeZoneId()).toInstant()
					),
					text: Option.filter(
						Option.fromUndefinedOr(params.query),
						(query) => query.trim() !== ""
					),
				});
				return listing(found);
			})
		);

		yield* register(thread, ({ id }) =>
			Effect.gen(function* () {
				const found = yield* stored(id);
				const conversation = yield* store.conversation(found.conversationId);
				return threadText(conversation, yield* store.ownAddresses);
			})
		);

		yield* register(message, ({ full, id }) =>
			Effect.gen(function* () {
				const found = yield* stored(id);
				const body =
					full === true ? yield* graph.body(found.graphId) : found.body;
				return messageText(found, body);
			})
		);

		yield* register(attachment, ({ id, n }) =>
			Effect.gen(function* () {
				const found = yield* stored(id);
				const list = yield* numbered(found);
				if (n === undefined) {
					return attachmentList(list);
				}
				const chosen = list[n - 1];
				if (chosen === undefined) {
					return yield* NotFound.make({
						message: `#${id} has ${list.length} attachments, not ${n}.`,
					});
				}
				if (chosen["@odata.type"] === "#microsoft.graph.referenceAttachment") {
					return yield* Refused.make({
						message: `Attachment ${n} is a link to a file, not a file.`,
					});
				}
				const bytes = yield* graph.attachmentContent(found.graphId, chosen.id);
				const dir = path.join(cache, String(id));
				const saved = path.join(
					dir,
					`${n}-${fileName(chosen.name)}${chosen["@odata.type"] === "#microsoft.graph.itemAttachment" ? ".eml" : ""}`
				);
				yield* fs
					.makeDirectory(dir, { mode: 0o700, recursive: true })
					.pipe(Effect.orDie);
				yield* fs.writeFile(saved, bytes).pipe(Effect.orDie);
				return saved;
			})
		);

		yield* register(draft, (input) =>
			Effect.flatMap(drafted(input), savedLine)
		);

		yield* register(updateDraft, ({ attach, bcc, body, cc, id, subject, to }) =>
			Effect.gen(function* () {
				const current = yield* currentDraft(id);
				const files = yield* readFiles(attach ?? []);
				const changed = Arr.some(
					[bcc, body, cc, subject, to],
					(field) => field !== undefined
				)
					? yield* graph.update(current.id, {
							bcc,
							cc,
							subject,
							text: body,
							to,
						})
					: current;
				return yield* savedLine(yield* attachFiles(changed, files));
			})
		);

		yield* register(deleteDraft, ({ id }) =>
			Effect.flatMap(currentDraft(id), (current) =>
				graph.move(current.id, "deleteditems")
			).pipe(Effect.flatMap(savedLine))
		);

		yield* register(send, (params) =>
			decodeSend(params).pipe(
				Effect.mapError(() =>
					Refused.make({
						message:
							"send takes { draft, to, cc, bcc, subject } to send a draft, or kind and the other fields of draft to send a message at once, not fields of both.",
					})
				),
				Effect.flatMap((shape) =>
					"draft" in shape ? sendDraft(shape) : sendNow(shape)
				)
			)
		);

		yield* register(update, ({ categories, flag, ids, move_to, read }) =>
			Effect.gen(function* () {
				if (
					Arr.every(
						[categories, flag, move_to, read],
						(field) => field === undefined
					)
				) {
					return yield* Refused.make({
						message: "Give read, flag, categories or move_to.",
					});
				}
				const destination = yield* Effect.transposeOption(
					Option.map(Option.fromUndefinedOr(move_to), folderNamed)
				);
				if (
					Option.isSome(destination) &&
					(yield* inDeletedItems(destination.value))
				) {
					return yield* Refused.make({
						message: `update does not move messages to ${destination.value.path}; use delete, which moves them to Deleted Items.`,
					});
				}
				return yield* each(ids, (id) =>
					Effect.gen(function* () {
						const found = yield* stored(id);
						const patched =
							categories === undefined &&
							flag === undefined &&
							read === undefined
								? yield* graph.message(found.graphId)
								: yield* graph.update(found.graphId, {
										categories,
										flag,
										isRead: read,
									});
						return yield* savedLine(
							Option.isSome(destination)
								? yield* graph.move(patched.id, destination.value.id)
								: patched
						);
					})
				);
			})
		);

		yield* register(deleteMessages, ({ ids }) =>
			each(ids, (id) =>
				Effect.flatMap(stored(id), (found) =>
					graph.move(found.graphId, "deleteditems")
				).pipe(Effect.flatMap(savedLine))
			)
		);
	})
);

/**
 * `mx mcp`: the tools over stdio, on MCP 2026-07-28, where every request carries its own protocol version. The server
 * reads requests as soon as it starts, so the store and Graph open before it, and the tools register right after it
 * with nothing to wait for; a `tools/list` never answers before them.
 */
export const serve = (version: string) =>
	tools.pipe(
		Layer.provide(
			McpServer.layerStdio({
				instructions:
					"mx is a local copy of the user's Microsoft 365 mailbox, kept current by mx sync, with tools to search and read it and to draft, send, file, flag and delete mail. Messages are named by short local ids such as #12. delete moves messages to Deleted Items; nothing deletes mail for good.",
				name: "mx",
				protocols: [McpProtocol.v2026_07_28],
				version,
			})
		),
		Layer.provide(Layer.mergeAll(Graph.layer, Store.layer)),
		Layer.provide(Paths.layer)
	);
