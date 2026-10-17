import { Array as Arr, Option } from "effect";
import type { Attachment } from "../graph/api.ts";
import type { Address, Stored } from "../store.ts";

/** Exchange writes an inline image into a text body as `[cid:<content id>]`. */
const cidReference = /\[cid:([^\]\s]+)\]/gu;

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** `2026-10-14 09:12` in the machine's time zone. */
const when = (instant: Temporal.Instant) => {
	const local = instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
	return `${local.toPlainDate().toString()} ${twoDigits(local.hour)}:${twoDigits(local.minute)}`;
};

const date = (message: Stored) =>
	Option.match(
		Option.orElse(message.received, () => message.sent),
		{
			onNone: () => "(no date)",
			onSome: when,
		}
	);

const person = ({ address, name }: Address) =>
	name === "" || name === address ? address : `${name} <${address}>`;

const people = (list: readonly Address[]) =>
	Arr.join(Arr.map(list, person), ", ");

const markers = (message: Stored) =>
	Arr.join(
		Arr.filter(
			[
				message.read ? "" : "unread",
				message.flag === "flagged" ? "flagged" : "",
				message.flag === "complete" ? "done" : "",
				message.attachments ? "att" : "",
				message.draft ? "draft" : "",
			],
			(marker) => marker !== ""
		),
		" "
	);

/** The content ids a text body references, each once, in the order the body first shows them. */
const referencedImages = (text: string) =>
	Arr.dedupe(Arr.map([...text.matchAll(cidReference)], ([, cid]) => cid ?? ""));

/** The body with CRLF line ends, trailing space and runs of blank lines cut, and each inline image as `[img N]`. */
const bodyText = (text: string) => {
	const images = referencedImages(text);
	return text
		.replaceAll("\r\n", "\n")
		.replaceAll(
			cidReference,
			(_, cid: string) => `[img ${images.indexOf(cid) + 1}]`
		)
		.replaceAll(/[ \t]+$/gmu, "")
		.replaceAll(/\n{3,}/gu, "\n\n")
		.trim();
};

/** One line per message: `#id date folder | sender | subject | markers`; a draft names its recipients instead. */
export const line = (message: Stored) => {
	const party = message.draft
		? `to ${people(message.to) || "nobody yet"}`
		: Option.match(message.from, {
				onNone: () => "(no sender)",
				onSome: person,
			});
	const flags = markers(message);
	return `#${message.id} ${date(message)} ${message.folder} | ${party} | ${message.subject || "(no subject)"}${flags === "" ? "" : ` | ${flags}`}`;
};

export const listing = (messages: readonly Stored[]) =>
	messages.length === 0
		? "No messages."
		: Arr.join(Arr.map(messages, line), "\n");

/** Headers, then `body`: the new text from the store, or the whole body Graph returned. */
export const messageText = (stored: Stored, body: string) => {
	const flags = markers(stored);
	return Arr.join(
		[
			`#${stored.id} ${date(stored)} ${stored.folder}${flags === "" ? "" : ` | ${flags}`}`,
			...Option.match(stored.from, {
				onNone: () => [],
				onSome: (from) => [`From: ${person(from)}`],
			}),
			`To: ${people(stored.to)}`,
			...(stored.cc.length === 0 ? [] : [`Cc: ${people(stored.cc)}`]),
			...(stored.bcc.length === 0 ? [] : [`Bcc: ${people(stored.bcc)}`]),
			`Subject:${stored.subject || "(no subject)"}`,
			...(stored.categories.length === 0
				? []
				: [`Categories: ${Arr.join(stored.categories, ", ")}`]),
			"",
			bodyText(body),
		],
		"\n"
	);
};

/** The conversation oldest first; Devin's own messages say `(me)` in place of a From line. */
export const threadText = (
	messages: readonly Stored[],
	own: ReadonlySet<string>
) => {
	const isOwn = (stored: Stored) =>
		stored.inSentItems ||
		Option.exists(stored.from, ({ address }) => own.has(address.toLowerCase()));
	const entries = Arr.map(messages, (stored) =>
		Arr.join(
			[
				`#${stored.id} ${date(stored)} ${stored.folder}${stored.draft ? " draft" : ""}${isOwn(stored) ? " (me)" : ""}`,
				...(isOwn(stored)
					? []
					: [
							`From: ${Option.match(stored.from, {
								onNone: () => "(no sender)",
								onSome: person,
							})}`,
						]),
				`To: ${people(stored.to)}`,
				...(stored.cc.length === 0 ? [] : [`Cc: ${people(stored.cc)}`]),
				...(stored.bcc.length === 0 ? [] : [`Bcc: ${people(stored.bcc)}`]),
				bodyText(stored.body),
			],
			"\n"
		)
	);
	const subject = Option.match(Arr.head(messages), {
		onNone: () => "",
		onSome: (first) => first.subject || "(no subject)",
	});
	return Arr.join(
		[`${subject}, ${messages.length} messages`, ...entries],
		"\n\n"
	);
};

const contentId = (attachment: Attachment) =>
	(attachment.contentId ?? "").replaceAll(/^<|>$/gu, "");

/** The attachments, inline images in the order the body shows them first, then the rest in Graph's order. */
export const inBodyOrder = (
	attachments: readonly Attachment[],
	body: string
): readonly Attachment[] => {
	const shown = Arr.getSomes(
		Arr.map(referencedImages(body), (cid) =>
			Arr.findFirst(
				attachments,
				(attachment) => attachment.isInline && contentId(attachment) === cid
			)
		)
	);
	return [
		...shown,
		...Arr.filter(attachments, (attachment) => !shown.includes(attachment)),
	];
};

const size = (bytes: number) => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** One line per attachment: `N name (type, size[, inline])`, numbered as `inBodyOrder` orders them. */
export const attachmentList = (list: readonly Attachment[]) =>
	list.length === 0
		? "No attachments."
		: Arr.join(
				Arr.map(
					list,
					(attachment, index) =>
						`${index + 1} ${attachment.name} (${attachment.contentType ?? "unknown type"}, ${size(attachment.size)}${attachment.isInline ? ", inline" : ""})`
				),
				"\n"
			);
