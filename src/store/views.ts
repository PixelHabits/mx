import { outlookLink } from "../outlook.ts";

/**
 * The aliases of the accounts, by their id in the store. Config, not the store, holds the aliases, so the connection that
 * runs a query fills this TEMP table before it creates the views. An account the store holds and the table does not list
 * shows by its id, as `account 2`, so no mail leaves the views when config.json and the store disagree.
 */
export const aliasesTable =
	"CREATE TEMP TABLE aliases (account_id INTEGER PRIMARY KEY, alias TEXT NOT NULL)";

/**
 * The views the `query` tool reads, its documented schema: the mail with readable values, the folders with their
 * counts, and the conversations, each with its account's alias. Each is a TEMP view of the connection that runs the
 * query, so the store holds none of them and a change to a table changes its views here, with the same commit. A view
 * shadows the table of its name, so each one reads the store's tables as `main.<table>`.
 *
 * The views hold no message bodies, which `search` finds words in and `message` reads, and no delta link. A message's
 * Graph id shows only inside its Outlook link.
 */
export const views = [
	// A time as UTC ISO 8601 text to the second, such as 2026-10-01T14:00:00Z, from the epoch milliseconds stored.
	// Recipients and categories are JSON arrays, of addresses and of names, which json_each splits. A message is from
	// the user as thread marks it (me): it is in Sent Items, or its sender is an address a message in Sent Items has.
	// A link opens the message in Outlook on the web.
	`CREATE TEMP VIEW mail AS
SELECT m.id,
	coalesce(a.alias, 'account ' || f.account_id) AS account,
	f.path AS folder,
	m.conversation_id,
	strftime('%Y-%m-%dT%H:%M:%SZ', m.received_at / 1000, 'unixepoch') AS received_at,
	strftime('%Y-%m-%dT%H:%M:%SZ', m.sent_at / 1000, 'unixepoch') AS sent_at,
	NULLIF(m.from_name, '') AS from_name,
	NULLIF(m.from_address, '') AS from_address,
	(SELECT json_group_array(r.value ->> 'address') FROM json_each(m.to_list) r) AS to_addresses,
	(SELECT json_group_array(r.value ->> 'address') FROM json_each(m.cc_list) r) AS cc_addresses,
	(SELECT json_group_array(r.value ->> 'address') FROM json_each(m.bcc_list) r) AS bcc_addresses,
	m.subject,
	m.is_read,
	m.flag,
	m.categories,
	m.importance,
	m.has_attachments,
	m.is_draft,
	(f.sent = 1 OR lower(m.from_address) IN (
		SELECT lower(o.from_address) FROM main.messages o JOIN main.folders s ON s.id = o.folder_id
		WHERE s.sent = 1 AND o.from_address != ''
	)) AS from_me,
	${outlookLink("m.graph_id")} AS link
FROM main.messages m JOIN main.folders f ON f.id = m.folder_id LEFT JOIN aliases a ON a.account_id = f.account_id`,
	`CREATE TEMP VIEW folders AS
SELECT coalesce(a.alias, 'account ' || f.account_id) AS account, f.path, count(m.id) AS total, count(m.id) FILTER (WHERE m.is_read = 0) AS unread
FROM main.folders f LEFT JOIN aliases a ON a.account_id = f.account_id LEFT JOIN main.messages m ON m.folder_id = f.id
GROUP BY f.id`,
	// The newest message comes first as search orders it: by when it arrived, a draft by when it was sent or saved.
	`CREATE TEMP VIEW conversations AS
SELECT account, conversation_id, messages, unread, mine, id AS last_id, link AS last_link FROM (
	SELECT account, conversation_id, id, link,
		count(*) OVER whole AS messages,
		sum(NOT is_read) OVER whole AS unread,
		sum(from_me) OVER whole AS mine,
		row_number() OVER (PARTITION BY account, conversation_id ORDER BY coalesce(received_at, sent_at) DESC, id DESC) AS place
	FROM mail
	WINDOW whole AS (PARTITION BY account, conversation_id)
) WHERE place = 1`,
];
