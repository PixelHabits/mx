/**
 * Outlook on the web opens a message at a deep link to its ItemID: the Graph immutable id in standard base64, URL-encoded.
 * Graph writes the id with `-` for `/` and `_` for `+`, and holds nothing else but letters, digits and `=` padding.
 */
const start = "https://outlook.cloud.microsoft/mail/deeplink?ItemID=";
const end = "&exvsurl=1&viewmodel=ReadMessageItem";

/** The SQL expression of the link that opens the message whose Graph id is in `column`, which the store and the views share. */
export const outlookLink = (column: string) =>
	`'${start}' || replace(replace(replace(${column}, '-', '%2F'), '_', '%2B'), '=', '%3D') || '${end}'`;

const whole = new RegExp(
	`^${RegExp.escape(start)}[\\dA-Za-z%]+${RegExp.escape(end)}$`,
	"u"
);

/** Whether `text` is a whole link that `outlookLink` builds. */
export const isOutlookLink = (text: string) => whole.test(text);
