import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Predicate,
	pipe,
	Result,
	Schema,
	String as Str,
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
import {
	FlagStatus,
	type Message,
	type Recipient,
	wellKnownFolders,
} from "../graph/api.ts";
import {
	type Compose,
	Graph,
	type GraphError,
	isFolderExists,
	isNotFound,
} from "../graph/graph.ts";
import { Log } from "../log.ts";
import { Paths } from "../paths.ts";
import { Query } from "../query.ts";
import { syncWarning } from "../status.ts";
import { Store, type Stored, type StoredFolder } from "../store.ts";
import { Sync } from "../sync.ts";
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

/** The conversations a search lists when the agent names no limit, and the most it lists. */
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

const Format = Schema.Literals(["markdown", "html"]).annotate({
	description:
		"How body is written: markdown unless given, or html for formatting Markdown has no syntax for, such as a font, colour or size the user asks for.",
});

/** The body as the HTML Graph takes: Markdown rendered, or HTML as given. */
const bodyHtml = ({
	body,
	format,
}: {
	readonly body?: string;
	readonly format?: typeof Format.Type;
}) => {
	if (body === undefined || format === "html") {
		return body;
	}
	return Bun.markdown.html(body, { autolinks: true });
};

/** The fields that make a message, shared by `draft` and an inline `send`. */
const composeFields = {
	attach: Schema.optionalKey(Files),
	bcc: Schema.optionalKey(Addresses),
	body: Schema.optionalKey(
		Schema.String.annotate({
			description:
				"Markdown, or HTML when format is html. Leave a blank line between paragraphs, and end a line with a backslash to start a new line inside a paragraph, as in a sign-off. A reply or forward puts it above the quoted conversation.",
		})
	),
	cc: Schema.optionalKey(Addresses),
	format: Schema.optionalKey(Format),
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
		Arr.join(Arr.sort(Arr.map(list, Str.toLowerCase), Order.String), "\n");
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

const NamedFolder = Schema.String.annotate({
	description: "A folder name or path, such as Inbox or Inbox/Projects.",
});

const search = Tool.make("search", {
	description:
		"Search the local copy of the mailbox. query matches words and their other forms in the subject, the sender and the message's new text; every filter is optional. Answers one line per conversation, best match first, or newest first without a query: #id date folder | sender | subject | markers, and (+N in thread) when the conversation holds N more messages, which thread shows.",
	parameters: Schema.Struct({
		folder: Schema.optionalKey(NamedFolder),
		from: Schema.optionalKey(
			Schema.String.annotate({
				description: "Part of the sender's name or address.",
			})
		),
		limit: Schema.optionalKey(
			Schema.Int.check(
				Schema.isBetween({ maximum: maxLimit, minimum: 1 })
			).annotate({
				description: `How many conversations to list, ${defaultLimit} unless given.`,
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

const sqlQuery = Tool.make("query", {
	description: `Runs one read-only SQLite SELECT over the local copy of the mailbox, to count, group, join and filter mail instead of reading many search lines. Answers a tab-separated table with a header row: at most 200 rows and 20000 characters, each value but a link cut at 200 characters. Times are UTC ISO 8601 text, such as 2026-10-01T14:00:00Z; is_ and has_ columns and from_me are 1 or 0.
Views:
- mail, one row per message: id (the #id), folder (a path such as Inbox/Projects), conversation_id, received_at, sent_at, from_name, from_address, to_addresses, cc_addresses, bcc_addresses, subject, is_read, flag (notFlagged, flagged or complete), categories, importance (low, normal or high), has_attachments, is_draft, from_me (the user sent it), link (opens the message in Outlook on the web). to_addresses, cc_addresses, bcc_addresses and categories are JSON arrays; split them with json_each.
- folders: path, total (messages), unread.
- conversations, one row per conversation: conversation_id, messages, unread, mine (messages the user sent), last_id (the id of its newest message), last_link (the link of its newest message).
Message bodies are not here: search finds words in them, and message reads one.
Examples:
SELECT from_address, count(*) AS n FROM mail WHERE folder = 'Inbox' AND received_at >= '2026-10-01' GROUP BY from_address ORDER BY n DESC
SELECT m.id, m.from_name, m.subject FROM conversations c JOIN mail m ON m.id = c.last_id WHERE m.folder = 'Inbox' AND NOT m.from_me`,
	parameters: Schema.Struct({
		sql: Schema.String.annotate({
			description:
				"One SELECT, or WITH and a SELECT, with no semicolon and no parameters.",
		}),
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
		body: Schema.optionalKey(
			Schema.String.annotate({
				description:
					"Markdown, or HTML when format is html. Leave a blank line between paragraphs, and end a line with a backslash to start a new line inside a paragraph, as in a sign-off.",
			})
		),
		cc: Schema.optionalKey(Addresses),
		format: Schema.optionalKey(Format),
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
		"Sends mail. Either send a draft with { draft, to, cc, bcc, subject }, where to, cc, bcc and subject repeat the draft's current values, an empty list where it has none; recipients may differ in order and case, and any other mismatch sends nothing. Or send a message at once with the fields of draft: kind, message, to, cc, bcc, subject, body, format and attach.",
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

const changeFolder = Tool.make("folder", {
	description:
		"Creates, renames or moves a mail folder, one change per call. create makes each missing folder of a path from the top of the mailbox, such as Inbox/Projects/Acme. rename with name gives a folder a new name. move with to puts a folder, with everything in it, into the folder to, or at the top of the mailbox when to is /. Folders are named as in search. Outlook's own folders, such as Inbox and Sent Items, are never renamed or moved, and nothing changes in Deleted Items, where only delete_folder moves a folder.",
	parameters: Schema.Struct({
		create: Schema.optionalKey(
			Schema.String.annotate({
				description:
					"A path from the top of the mailbox, such as Inbox/Projects/Acme.",
			})
		),
		move: Schema.optionalKey(NamedFolder),
		name: Schema.optionalKey(
			Schema.String.annotate({ description: "The new name, with rename." })
		),
		rename: Schema.optionalKey(NamedFolder),
		to: Schema.optionalKey(
			NamedFolder.annotate({
				description:
					"The folder that move puts the folder in, or / for the top of the mailbox.",
			})
		),
	}),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, false);

/** `folder`'s three changes; a call that mixes their fields matches none. */
const decodeFolderChange = Schema.decodeUnknownEffect(
	Schema.Union([
		Schema.Struct({ create: Schema.String }),
		Schema.Struct({ name: Schema.String, rename: Schema.String }),
		Schema.Struct({ move: Schema.String, to: Schema.String }),
	]),
	{ onExcessProperty: "error" }
);

const deleteFolder = Tool.make("delete_folder", {
	description:
		"Moves a folder, with the folders and messages in it, to Deleted Items, where Outlook can restore it. Refuses Outlook's own folders, such as Inbox, and the folders already in Deleted Items.",
	parameters: Schema.Struct({ folder: NamedFolder }),
})
	.annotate(Tool.Destructive, true)
	.annotate(Tool.OpenWorld, false);

/** Whether an agent runs a tool without asking or asks every time. */
export type Approval = "allow" | "ask";

/**
 * The approval mx recommends for each tool, in the order mx lists them: only `send`, `delete` and `delete_folder` ask
 * every time. The hints do not decide it: `update_draft`, `delete_draft`, `update` and `folder` are destructive and
 * still run without asking.
 */
export const recommendedApprovals: readonly {
	readonly approval: Approval;
	readonly tool: string;
}[] = [
	{ approval: "allow", tool: search.name },
	{ approval: "allow", tool: sqlQuery.name },
	{ approval: "allow", tool: thread.name },
	{ approval: "allow", tool: message.name },
	{ approval: "allow", tool: attachment.name },
	{ approval: "allow", tool: draft.name },
	{ approval: "allow", tool: updateDraft.name },
	{ approval: "allow", tool: deleteDraft.name },
	{ approval: "ask", tool: send.name },
	{ approval: "allow", tool: update.name },
	{ approval: "ask", tool: deleteMessages.name },
	{ approval: "allow", tool: changeFolder.name },
	{ approval: "ask", tool: deleteFolder.name },
];

const textResult = (text: string, isError: boolean) =>
	McpSchema.CallToolResult.make({
		content: [{ text, type: "text" }],
		isError,
	});

/** What mx answers a call: its text, and whether the text is an error. */
interface Answer {
	readonly isError: boolean;
	readonly text: string;
}

/**
 * Runs `answer`, mx's answer to one `tools/call` or `prompts/get`, and writes the call to the log as it ends: the agent
 * that asked, what it sent, and what mx answered or how the call failed. Writing never fails the call, since a call
 * whose side effect ran must answer: had `send` failed after Microsoft took the mail, the agent would send it again.
 */
const logged = <E extends { readonly message: string }>(
	log: Log["Service"],
	call: {
		readonly arguments: unknown;
		readonly kind: "tool" | "prompt";
		readonly name: string;
	},
	answer: Effect.Effect<Answer, E>
) =>
	Effect.gen(function* () {
		const { clientInfo } = yield* McpSchema.McpRequestContext;
		const started = yield* Clock.currentTimeMillis;
		return yield* Effect.onExit(answer, (exit) =>
			Effect.flatMap(Clock.currentTimeMillis, (ended) =>
				log.write({
					...call,
					agent: Option.map(
						Option.fromUndefinedOr(clientInfo),
						({ name, version }) => ({ name, version })
					),
					at: Temporal.Instant.fromEpochMilliseconds(started),
					duration: Duration.millis(ended - started),
					...Exit.match(exit, {
						onFailure: (cause) => ({
							isError: true,
							result: Option.match(Cause.findErrorOption(cause), {
								onNone: () => Cause.pretty(cause),
								onSome: (error) => error.message,
							}),
						}),
						onSuccess: ({ isError, text }) => ({ isError, result: text }),
					}),
				})
			)
		);
	});

/**
 * Registers `tool` with a handler that answers plain text, with the line `note` gives, if any, before it, and logs each
 * call. `McpServer.toolkit` would answer every result as JSON and repeat it as structured content, which Claude Code
 * shows the model in place of the text.
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
	run: (params: P["Type"]) => Effect.Effect<string, ToolError>,
	note: Effect.Effect<Option.Option<string>> = Effect.succeedNone
) {
	const server = yield* McpServer.McpServer;
	const log = yield* Log;
	const decode = Schema.decodeUnknownEffect(tool.parametersSchema);
	yield* server.addTool({
		annotations: tool.annotations,
		handle: (payload: unknown) =>
			logged(
				log,
				{ arguments: payload ?? {}, kind: "tool", name: tool.name },
				decode(payload ?? {}).pipe(
					Effect.mapError((error) =>
						McpSchema.InvalidParams.make({ message: error.message })
					),
					Effect.flatMap((params) =>
						run(params).pipe(
							Effect.match({
								onFailure: (error) => ({ isError: true, text: error.message }),
								onSuccess: (text) => ({ isError: false, text }),
							})
						)
					),
					Effect.flatMap(({ isError, text }) =>
						Effect.map(note, (warning) => ({
							isError,
							text: Option.match(warning, {
								onNone: () => text,
								onSome: (first) => `${first}\n${text}`,
							}),
						}))
					)
				)
			).pipe(Effect.map(({ isError, text }) => textResult(text, isError))),
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

/** Refuses a name no path could hold: a blank one, or one with `/`, which separates the folders of a path. */
const checkFolderName = (name: string) =>
	Str.trim(name) === "" || pipe(name, Str.includes("/"))
		? Refused.make({
				message: `"${name}" is not a folder name: a name is not blank and holds no /, which separates the folders of a path.`,
			})
		: Effect.void;

/** The path of the folder that holds the folder at `path`, or none at the top of the mailbox. */
const parentOf = (path: string) =>
	Option.map(pipe(path, Str.lastIndexOf("/")), (end) =>
		pipe(path, Str.slice(0, end))
	);

const unsafeInFileName = /[/\\\0]/gu;
const leadingDots = /^\.+/u;

/** An attachment name safe to write in the cache: no directory parts and no leading dot. */
const fileName = (name: string) =>
	pipe(
		name,
		Str.replaceAll(unsafeInFileName, "_"),
		Str.replace(leadingDots, "_")
	) || "attachment";

/** The day triage starts from unless the agent names one: 7 days before the user's today. */
const weekAgo = Effect.map(Clock.currentTimeMillis, (now) =>
	Temporal.Instant.fromEpochMilliseconds(now)
		.toZonedDateTimeISO(Temporal.Now.timeZoneId())
		.toPlainDate()
		.subtract({ days: 7 })
);

const triageText = (
	since: string
) => `Triage the user's mail received since ${since}.

1. Look for the user's mail preferences in your memory or instructions: who matters, what is noise, how they file mail. If there are none, say once that the interview prompt can set them up, then carry on.
2. Count first with query: unread Inbox mail since ${since} by sender, and the Inbox conversations whose newest message isn't the user's. Then survey with search: folder Inbox, since ${since}, no query, limit 200. If 200 lines come back, tell the user how far back the survey reached. Judge each conversation from its line. Don't open automated mail unless a preference says it matters, or its subject shows a failure or a deadline.
3. Open the conversations from people with thread. Note what each one asks of the user, and whether the user already replied.
4. Report in this order: what needs the user's reply, with the ask and the date; what needs other action; failing systems and alerts; then a count of the rest, grouped by sender, which query can count.
5. Change nothing in the mailbox. Offer the moves, flags and deletes you would make, and make them only after the user agrees.`;

const interviewText = `Learn how the user handles mail, so later triage follows their way of working.

1. Survey first, before you ask anything. Use query for the last 30 days: who writes to the user most, whom the user writes to, the folders and how full they are, what the user flags, and which conversations the user answered. Then read a sample of each kind of mail with search to tell people from automated senders.
2. Then interview the user, a few questions at a time: their role and what they are responsible for; whose mail always matters; which automated mail they want to see and which is noise; how they want mail filed (folders, categories, flags); how fast they reply and what counts as urgent; what triage should leave alone.
3. Write a short summary of their preferences, and show it to them for corrections.
4. If you can save memories, or edit an instruction file such as CLAUDE.md or AGENTS.md, save the agreed summary there under the heading "Mail preferences". If you can't, give the user the summary to paste into their agent's custom instructions.
5. Change nothing in the mailbox during the interview.`;

/** Runs `content`, the text of the prompt `name`, logged as a `prompts/get` of it with `params`. */
const loggedPrompt = (
	log: Log["Service"],
	name: string,
	params: unknown,
	content: Effect.Effect<string>
) =>
	logged(
		log,
		{ arguments: params, kind: "prompt", name },
		Effect.map(content, (text) => ({ isError: false, text }))
	).pipe(Effect.map(({ text }) => text));

/**
 * The MCP prompts, registered on the `McpServer` in context. A prompt logs the arguments it decoded, which are the ones
 * the agent sent; arguments it cannot decode never reach it, and the agent gets the error.
 */
const prompts = Effect.flatMap(Log, (log) =>
	Effect.andThen(
		McpServer.registerPrompt({
			content: ({ since }) =>
				loggedPrompt(
					log,
					"triage",
					{ since },
					Effect.map(
						since === undefined ? weekAgo : Effect.succeed(since),
						(day) => triageText(day.toString())
					)
				),
			description: "Review new mail and report what needs the user",
			name: "triage",
			parameters: {
				since: Schema.optionalKey(
					PlainDateFromString.annotate({
						description:
							"The first day of mail to triage, as YYYY-MM-DD; 7 days before today unless given.",
					})
				),
			},
		}),
		McpServer.registerPrompt({
			content: () =>
				loggedPrompt(log, "interview", {}, Effect.succeed(interviewText)),
			description: "Learn how the user handles mail, so triage follows it",
			name: "interview",
		})
	)
);

/**
 * The MCP tools, then the prompts, registered on the `McpServer` in context. Reads answer from the store; writes go to
 * Graph first.
 */
export const tools = Layer.effectDiscard(
	Effect.gen(function* () {
		const store = yield* Store;
		const graph = yield* Graph;
		const sync = yield* Sync;
		const queries = yield* Query;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const { cache } = yield* Paths;

		/** For the read tools, which answer from the store: a line when mx sync never ran, stopped or lost its sign-in. */
		const storeNote = Effect.gen(function* () {
			const now = Temporal.Instant.fromEpochMilliseconds(
				yield* Clock.currentTimeMillis
			);
			return syncWarning(yield* store.heartbeat, now);
		});

		const registerRead: typeof register = (tool, run) =>
			register(tool, run, storeNote);

		const stored = Effect.fnUntraced(function* (id: number) {
			const found = yield* store.byId(id);
			if (Option.isNone(found)) {
				return yield* NotFound.make({
					message: `No message #${id}. It may have been moved out of reach or deleted; search again.`,
				});
			}
			return found.value;
		});

		/**
		 * Runs `request`, the call or reads that name the stored message, on its Graph id. When Graph answers 404, mx looks
		 * the message up by its immutable id, which a move within the mailbox keeps: one Graph no longer holds leaves the
		 * store, and the tool says so; one Graph still holds is refiled, and the tool answers the 404.
		 */
		const onMessage = <A>(
			found: Stored,
			request: (graphId: string) => Effect.Effect<A, ToolError>
		) =>
			request(found.graphId).pipe(
				Effect.catchIf(isNotFound, (missing) =>
					Effect.gen(function* () {
						if (Option.isNone(yield* sync.locate(found.graphId))) {
							return yield* NotFound.make({
								message: `#${found.id} is no longer in the mailbox.`,
							});
						}
						return yield* missing;
					})
				)
			);

		/**
		 * Runs `write` on the draft as Graph holds it now, refused unless it is still a draft. The read and the write run
		 * through `onMessage` together, so a draft deleted between them is answered as any message Graph no longer holds.
		 */
		const onDraft = <A>(
			id: number,
			write: (draft: Message) => Effect.Effect<A, ToolError>
		) =>
			Effect.flatMap(stored(id), (found) =>
				onMessage(found, (graphId) =>
					Effect.gen(function* () {
						const current = yield* graph.message(graphId);
						if (!current.isDraft) {
							return yield* Refused.make({ message: `#${id} is not a draft.` });
						}
						return yield* write(current);
					})
				)
			);

		/** Looks a message up in Graph after a write, files it and answers its listing line. */
		const savedLine = Effect.fnUntraced(function* (graphId: string) {
			yield* sync.locate(graphId);
			const saved = yield* store.byGraphId(graphId);
			if (Option.isNone(saved)) {
				return yield* NotFound.make({
					message: "The message is no longer in the mailbox.",
				});
			}
			return line(saved.value);
		});

		const folderNamed = Effect.fnUntraced(function* (name: string) {
			const wanted = Str.toLowerCase(name);
			const folders = yield* store.folders;
			const byPath = Arr.filter(
				folders,
				(folder) => Str.toLowerCase(folder.path) === wanted
			);
			const matches =
				byPath.length > 0
					? byPath
					: Arr.filter(
							folders,
							(folder) => Str.toLowerCase(folder.name) === wanted
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

		/** The ids of Outlook's own folders that the mailbox has, by well-known name; they hold for the life of the process. */
		const wellKnown = yield* Effect.cachedWithTTL(
			Effect.forEach(wellKnownFolders, (name) =>
				graph.folder(name).pipe(
					Effect.map(({ id }) => Option.some([name, id] as const)),
					Effect.catchIf(isNotFound, () => Effect.succeedNone)
				)
			).pipe(Effect.map((found) => new Map(Arr.getSomes(found)))),
			(exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
		);

		/**
		 * Whether `folder` is Deleted Items or a folder inside it, where mail and folders go only through `delete` and
		 * `delete_folder`, which the client asks about.
		 */
		const inDeletedItems = Effect.fnUntraced(function* (folder: StoredFolder) {
			const id = (yield* wellKnown).get("deleteditems");
			if (id === undefined) {
				return yield* NotFound.make({
					message:
						"Graph found no Deleted Items in the mailbox, so mx cannot tell which folders are in it.",
				});
			}
			return Arr.some(
				yield* store.folders,
				(deleted) =>
					deleted.id === id &&
					pipe(`${folder.path}/`, Str.startsWith(`${deleted.path}/`))
			);
		});

		/** The folder `name` names, for `folder` or `delete_folder` to change: refused when Outlook keeps it, or in Deleted Items. */
		const changeable = Effect.fnUntraced(function* (name: string) {
			const found = yield* folderNamed(name);
			if (Arr.contains((yield* wellKnown).values(), found.id)) {
				return yield* Refused.make({
					message: `${found.path} is one of Outlook's own folders, which mx never renames, moves or deletes.`,
				});
			}
			if (yield* inDeletedItems(found)) {
				return yield* Refused.make({
					message: `${found.path} is in Deleted Items, where mx changes no folder; Outlook can restore it.`,
				});
			}
			return found;
		});

		/** Answers Graph's refusal of a second folder named `name` in the folder at `place`, or at the top of the mailbox. */
		const unlessTaken =
			(place: Option.Option<string>, name: string) =>
			<A>(change: Effect.Effect<A, GraphError>) =>
				Effect.catchIf(change, isFolderExists, () =>
					Refused.make({
						message: `${Option.getOrElse(place, () => "The top of the mailbox")} already has a folder named ${name}.`,
					})
				);

		/** Creates each folder of the path `wanted` below the deepest one the store has; answers the paths it created. */
		const createFolders = Effect.fnUntraced(function* (wanted: string) {
			const names = pipe(wanted, Str.split("/"));
			yield* Effect.forEach(names, checkFolderName, { discard: true });
			const byPath = new Map(
				Arr.map(yield* store.folders, (folder) => [
					Str.toLowerCase(folder.path),
					folder,
				])
			);
			const known = Arr.takeWhile(
				Arr.map(names, (_, last) =>
					byPath.get(Str.toLowerCase(Arr.join(names.slice(0, last + 1), "/")))
				),
				Predicate.isNotUndefined
			);
			const parent = Arr.last(known);
			if (known.length === names.length) {
				return yield* Refused.make({ message: `${wanted} already exists.` });
			}
			if (Option.isSome(parent) && (yield* inDeletedItems(parent.value))) {
				return yield* Refused.make({
					message: `${parent.value.path} is in Deleted Items, where folder creates no folder.`,
				});
			}
			let place: Option.Option<{ readonly id: string; readonly path: string }> =
				parent;
			const created: string[] = [];
			for (const name of names.slice(known.length)) {
				const made = yield* graph
					.createFolder(
						Option.map(place, (folder) => folder.id),
						name
					)
					.pipe(
						unlessTaken(
							Option.map(place, (folder) => folder.path),
							name
						)
					);
				const saved = yield* store.saveFolder(made, false);
				created.push(saved);
				place = Option.some({ id: made.id, path: saved });
			}
			return `Created ${Arr.join(created, ", ")}.`;
		});

		const renameFolder = Effect.fnUntraced(function* (
			target: string,
			name: string
		) {
			yield* checkFolderName(name);
			const found = yield* changeable(target);
			const renamed = yield* graph
				.renameFolder(found.id, name)
				.pipe(unlessTaken(parentOf(found.path), name));
			return `Renamed ${found.path} to ${yield* store.saveFolder(renamed, false)}.`;
		});

		const moveFolder = Effect.fnUntraced(function* (
			target: string,
			to: string
		) {
			const found = yield* changeable(target);
			const destination =
				to === "/" ? Option.none() : Option.some(yield* folderNamed(to));
			if (
				Option.isSome(destination) &&
				(yield* inDeletedItems(destination.value))
			) {
				return yield* Refused.make({
					message: `folder does not move folders to ${destination.value.path}; use delete_folder, which moves a folder to Deleted Items.`,
				});
			}
			const moved = yield* graph
				.moveFolder(
					found.id,
					Option.match(destination, {
						onNone: () => "msgfolderroot",
						onSome: ({ id }) => id,
					})
				)
				.pipe(
					unlessTaken(
						Option.map(destination, (folder) => folder.path),
						found.name
					)
				);
			return `Moved ${found.path} to ${yield* store.saveFolder(moved, false)}.`;
		});

		const numbered = (found: Stored) =>
			onMessage(found, (graphId) =>
				Effect.all([graph.attachments(graphId), graph.body(graphId)], {
					concurrency: 2,
				})
			).pipe(Effect.map(([list, body]) => inBodyOrder(list, body)));

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

		const attachFiles = (
			graphId: string,
			files: readonly { readonly bytes: Uint8Array; readonly name: string }[]
		) =>
			Effect.forEach(files, (file) => graph.attach({ ...file, id: graphId }), {
				discard: true,
			});

		/** Runs `request` on the message `input` composes; a reply or forward names its message through `onMessage`. */
		const composing = Effect.fnUntraced(function* <A>(
			input: ComposeInput,
			request: (compose: Compose) => Effect.Effect<A, ToolError>
		) {
			const fields = {
				bcc: input.bcc,
				cc: input.cc,
				html: bodyHtml(input),
				subject: input.subject,
				to: input.to,
			};
			if (input.kind === "new") {
				if (input.message !== undefined) {
					return yield* Refused.make({
						message: "kind new answers no message; leave message out.",
					});
				}
				return yield* request({ ...fields, kind: input.kind });
			}
			if (input.message === undefined) {
				return yield* Refused.make({
					message: `kind ${input.kind} needs message, the local id of the message it answers.`,
				});
			}
			const { kind } = input;
			return yield* onMessage(yield* stored(input.message), (id) =>
				request({ ...fields, id, kind })
			);
		});

		/** A new draft with its files attached; answers its Graph id. */
		const drafted = Effect.fnUntraced(function* (input: ComposeInput) {
			const files = yield* readFiles(input.attach ?? []);
			const id = yield* composing(input, graph.draft);
			yield* attachFiles(id, files);
			return id;
		});

		/**
		 * Sends a draft only when `to`, `cc`, `bcc` and `subject` repeat its own, so the client's approval prompt shows
		 * everyone it goes to. Graph sends the draft as it stands, so each of them counts.
		 */
		const sendDraft = ({
			draft: id,
			subject,
			...repeated
		}: typeof SendDraft.Type) =>
			onDraft(id, (current) =>
				Effect.gen(function* () {
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
				})
			);

		/** Sends in one request, or through a draft when files go with it, since only a draft takes attachments. */
		const sendNow = Effect.fnUntraced(function* (input: ComposeInput) {
			const files = yield* readFiles(input.attach ?? []);
			if (Arr.isReadonlyArrayNonEmpty(files)) {
				const id = yield* composing(input, graph.draft);
				yield* attachFiles(id, files);
				yield* graph.sendDraft(id);
			} else {
				yield* composing(input, graph.send);
			}
			return input.kind === "new"
				? `Sent to ${recipientsText({ bcc: input.bcc ?? [], cc: input.cc ?? [], to: input.to ?? [] })}: ${input.subject || "(no subject)"}`
				: `Sent the ${pipe(input.kind, Str.replace("_", "-"))} to #${input.message}.`;
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

		yield* registerRead(search, (params) =>
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
						(query) => Str.trim(query) !== ""
					),
				});
				return listing(found);
			})
		);

		yield* registerRead(sqlQuery, ({ sql }) => queries.run(sql));

		yield* registerRead(thread, ({ id }) =>
			Effect.gen(function* () {
				const found = yield* stored(id);
				const conversation = yield* store.conversation(found.conversationId);
				return threadText(conversation, yield* store.ownAddresses);
			})
		);

		yield* registerRead(message, ({ full, id }) =>
			Effect.gen(function* () {
				const found = yield* stored(id);
				if (full !== true) {
					return messageText(found, found.body);
				}
				const body = yield* onMessage(found, graph.body);
				return messageText(yield* stored(id), body);
			})
		);

		yield* registerRead(attachment, ({ id, n }) =>
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

		yield* register(
			updateDraft,
			({ attach, bcc, body, cc, format, id, subject, to }) =>
				onDraft(id, (current) =>
					Effect.gen(function* () {
						const files = yield* readFiles(attach ?? []);
						if (
							Arr.some(
								[bcc, body, cc, subject, to],
								(field) => field !== undefined
							)
						) {
							yield* graph.update(current.id, {
								bcc,
								cc,
								html: bodyHtml({ body, format }),
								subject,
								to,
							});
						}
						yield* attachFiles(current.id, files);
						return current.id;
					})
				).pipe(Effect.flatMap(savedLine))
		);

		yield* register(deleteDraft, ({ id }) =>
			onDraft(id, (current) => graph.move(current.id, "deleteditems")).pipe(
				Effect.flatMap(savedLine)
			)
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
						const moved = (graphId: string) =>
							Option.match(destination, {
								onNone: () => Effect.succeed(graphId),
								onSome: (folder) => graph.move(graphId, folder.id),
							});
						const written = Arr.some(
							[categories, flag, read],
							(field) => field !== undefined
						)
							? yield* onMessage(found, (graphId) =>
									graph.update(graphId, { categories, flag, isRead: read })
								).pipe(Effect.andThen(moved(found.graphId)))
							: yield* onMessage(found, moved);
						return yield* savedLine(written);
					})
				);
			})
		);

		yield* register(deleteMessages, ({ ids }) =>
			each(ids, (id) =>
				Effect.flatMap(stored(id), (found) =>
					onMessage(found, (graphId) => graph.move(graphId, "deleteditems"))
				).pipe(Effect.flatMap(savedLine))
			)
		);

		yield* register(changeFolder, (params) =>
			decodeFolderChange(params).pipe(
				Effect.mapError(() =>
					Refused.make({
						message:
							"folder takes create, rename and name, or move and to: one change per call.",
					})
				),
				Effect.flatMap((change) => {
					if ("create" in change) {
						return createFolders(change.create);
					}
					if ("rename" in change) {
						return renameFolder(change.rename, change.name);
					}
					return moveFolder(change.move, change.to);
				})
			)
		);

		yield* register(deleteFolder, ({ folder }) =>
			Effect.gen(function* () {
				const found = yield* changeable(folder);
				const moved = yield* graph
					.moveFolder(found.id, "deleteditems")
					.pipe(unlessTaken(Option.some("Deleted Items"), found.name));
				return `Moved ${found.path} to ${yield* store.saveFolder(moved, false)}, where Outlook can restore it.`;
			})
		);

		yield* prompts;
	})
);

const instructions = `mx is a local copy of the user's Microsoft 365 mailbox, kept current by mx sync. Messages have short local ids such as #12. delete and delete_folder move mail and folders to Deleted Items; nothing deletes mail for good.

Reading mail costs context:
- To count, group or compare mail, such as senders over a month or conversations still waiting on the user, call query with one SELECT instead of reading many search lines.
- To survey mail, call search with a folder and since and no query. Each line is one conversation, with its sender, subject and markers. Decide from the lines what to open.
- Open a conversation with thread. It includes the user's own replies, marked (me), so you don't need Sent Items to see whether the user answered.
- Use message for a single message. Use full only when the new text isn't enough, such as for quoted history or a forwarded original.
- update and delete take many ids at once.

thread, message and query's link column give a link that opens the message in Outlook on the web. Give it to the user when they want to open or answer the message themselves.

If the user has saved mail preferences in your memory or instructions, follow them. If they have none and ask you to triage, offer once to interview them first about how they handle mail.`;

/**
 * `mx mcp`: the tools and prompts over stdio, on MCP 2026-07-28, where every request carries its own protocol version,
 * and on the `initialize` handshakes that Claude Desktop opens at 2025-11-25 and Codex at 2025-06-18.
 * The server reads requests as soon as it starts, so the store and Graph open before it, and the tools and prompts
 * register right after it in one layer, with nothing to wait for; a `tools/list` or `prompts/list` never answers before
 * them.
 */
export const serve = (version: string) =>
	tools.pipe(
		Layer.provide(
			McpServer.layerStdio({
				instructions,
				name: "mx",
				protocols: [
					McpProtocol.v2026_07_28,
					McpProtocol.v2025_11_25,
					McpProtocol.v2025_06_18,
				],
				version,
			})
		),
		Layer.provide(
			Layer.mergeAll(
				Graph.layer,
				Store.layer,
				Sync.layer,
				Query.layer,
				Log.layer
			)
		),
		Layer.provide(Paths.layer)
	);
