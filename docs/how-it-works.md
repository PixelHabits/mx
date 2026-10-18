# How mx works

## Sync

`mx sync` runs in the background and keeps a local copy of the mailbox in SQLite, with a full-text index.

- **New mail:** mx subscribes to Microsoft Graph change notifications for Inbox and Sent Items. They reach a local webhook through a Cloudflare quick tunnel that `cloudflared` opens. mx uses the `cloudflared` that `MX_CLOUDFLARED` names, or the one on `PATH`. Otherwise it downloads a pinned release and checks its sha256. On macOS that release is a tarball, and mx takes `cloudflared` out of it. Each notification starts a delta pass of that folder.
- **First sync:** `mx install` runs the first sync in the foreground, before it starts `mx sync`, and shows progress from each folder's message count. Each folder's delta link is saved when the folder finishes, so a stopped first sync keeps the finished folders and the next `mx install` reads only the rest. A folder that was part way through starts over. Whether the first sync finishes, fails or is stopped, `mx install` ends by starting `mx sync`, which carries on from there.
- **Folders at once:** a pass syncs 3 folders at a time. Microsoft Graph allows 4 concurrent requests per app and mailbox, so one stays free for `mx mcp`.
- **Self-check:** after its first pass, and then once a day, `mx sync` compares every folder's message ids with Graph's. It adds messages the delta missed, refiles messages stored in the wrong folder, removes messages Graph no longer has, and drops deleted folders. It logs one line, such as `Reconciled 12 folders: 0 added, 0 refiled, 0 removed.`, and delta passes wait while it runs. A check that fails runs again an hour later.
- **Moves:** a delta page never moves a stored message out of the folder it is filed in. When a page and the store disagree, mx asks Graph where the message is now. Lookups from `mx sync` and `mx mcp` are applied in the order they began, so an older answer never overwrites a newer one. A delta entry that carries only the properties that changed is looked up by id the same way.
- **Refusals:** a folder or message that Graph refuses, or a page that mx cannot read, is skipped and shown as the last error in `mx status`, and sync carries on. The next folder listing drops a folder that is gone. Only an expired sign-in or a failing secret store stops `mx sync`.
- **Fallback:** while notifications work, mx also polls every folder every 5 minutes. When they don't, it polls every 60 seconds and tries notifications again every 10 minutes.
- **Stopping:** on Windows and macOS, stopping sync also ends its `cloudflared`. A forced stop can't delete the Graph subscriptions, so they expire within 3 days, and the next sync start deletes any that remain.
- **Health:** `mx sync` records a heartbeat every minute. `mx status` and the read tools use it to tell whether sync is running and how old the mail is.

## Store

The mail store is one SQLite file, `mx.sqlite`, in the data folder. It holds the folders with their delta links, one row per message, the local id each message got, and the full-text index.

- **Migrations:** each change to the store's schema is a numbered migration built into the binary. When it opens the store, mx runs the migrations the store has not recorded, in one transaction, and records each one in the `effect_sql_migrations` table. Migration 1 is the schema of mx 0.1.0, so a store that 0.1.0 created records it and keeps all its mail.
- **Newer stores:** a store that records a migration this mx does not know was written by a newer mx. mx refuses to open it, changes nothing, and says `This mail store was written by a newer mx. Run mx update.` `mx update` and `mx uninstall` still work.
- **Local ids:** apart from the `#N` id each message got, the store mirrors the mailbox. No migration changes the local ids. A migration that cannot convert the stored mail may clear every folder's delta link instead, so the next pass reads every folder again.
- **Transactions:** each mx process opens one connection to the store. A write runs in a transaction that holds the connection until it commits, and SQLite waits up to 5 seconds for a write lock that the other mx process holds.

## When a message is gone

When a tool's request to Graph, including a draft tool's, answers 404 for a stored message, mx looks the message up by its id. If Graph still has it, mx refiles it where Graph says and returns the error. If Graph no longer has it, mx removes it from the store, and the tool answers, for example, `#12 is no longer in the mailbox.`

## Search

`search` uses an SQLite FTS5 index over the subject, sender and new text. The porter stemmer matches word forms, so "approve" also finds "approved" and "approval". With a query, results are ranked by bm25, weighting the subject 10, the sender 2 and the body 1, with newer messages first among equals. Without a query, they are newest first. Each conversation appears once, by its best match, with `(+N in thread)` when it has more messages. `mx reindex` rebuilds the index from the stored messages.

## Query

`query` runs one SQL SELECT that the agent writes, so it can count, group and join mail instead of reading many search lines.

- **Views:** the SQL reads three views. `mail` has one row per message, `folders` has each folder's path with its message and unread counts, and `conversations` has one row per conversation with its newest message. Times are UTC ISO 8601 text. Message bodies aren't in the views; `search` finds words in them.
- **Read-only:** each query runs in a process of its own, `mx query-worker`, which opens the store read-only, so SQLite refuses every write. mx wraps the SQL in its own `SELECT * FROM (…)`, so SQLite accepts nothing but one SELECT: no `INSERT`, `ATTACH`, `PRAGMA` or second statement. The tool returns SQLite's error as it is.
- **Limits:** an answer has at most 200 rows and 20,000 characters, and each value is cut at 200 characters. Its last line says when a limit cut it short. mx stops a query that runs longer than 10 seconds.
- **Schema:** the query process creates the views each time it starts, so the store's tables can change while the views stay the same.

## Sign-in

The saved sign-in is one record in the system's secret store, or in a file only the user can read where no secret store exists. It holds the refresh token with the client id and tenant it belongs to, and an id that each `mx login` renews. Every Graph request reads the record, so a running `mx mcp` or `mx sync` switches to a new sign-in on its next request and never uses an old one. `mx login` also restarts `mx sync`.

## Updates

`mx sync` checks for a release when it starts and then once a day, and `mx update` checks at once. An update:

1. Fetches `latest.json` and `latest.json.sig` from the latest GitHub release.
2. Checks the Ed25519 signature against the release key compiled into mx.
3. Refuses a version that is not newer than the running one.
4. Downloads the binary for this platform and checks its size and sha256 against the manifest.
5. Writes the new binary beside the old one, swaps it into place, and restarts `mx sync`.

## Files

| Linux | macOS | Windows | Holds |
| --- | --- | --- | --- |
| `$XDG_CONFIG_HOME/mx/config.json` | `~/Library/Application Support/mx/config.json` | `%LOCALAPPDATA%\mx\config.json` | The client id and tenant from `mx login` |
| `$XDG_DATA_HOME/mx/` | `~/Library/Application Support/mx/data/` | `%LOCALAPPDATA%\mx\data\` | The mail store and a downloaded `cloudflared` |
| `$XDG_STATE_HOME/mx/` | `~/Library/Logs/mx/` | `%LOCALAPPDATA%\mx\state\` | The sign-in file on machines without a secret store; the sync log on macOS and Windows |
| `$XDG_CACHE_HOME/mx/` | `~/Library/Caches/mx/` | `%LOCALAPPDATA%\mx\cache\` | Saved attachments |

On Windows, Claude Desktop from the Microsoft Store keeps its config inside its app package, in `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`. `mx install` and `mx uninstall` change that file, and also `%APPDATA%\Claude\claude_desktop_config.json` when it exists.

On Linux the background service is the systemd user unit `mx-sync`. Its log is in the journal: `journalctl --user -u mx-sync -f`.

On macOS it is the LaunchAgent `io.github.pixelhabits.mx.sync`, in `~/Library/LaunchAgents/io.github.pixelhabits.mx.sync.plist`. launchd starts it at sign-in, and again after it fails, at most once every 5 minutes. Its log is `~/Library/Logs/mx/sync.log`: `tail -f ~/Library/Logs/mx/sync.log`.

## Trying the MCP server by hand

mx speaks MCP 2026-07-28 over stdio. It also speaks the `initialize` handshakes of MCP 2025-11-25, which Claude Desktop uses, and 2025-06-18, which Codex uses. On 2026-07-28 each request carries its protocol version in `_meta`, and there is no handshake:

```sh
meta='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
{
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$meta}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$meta}}"
  sleep 1
} | mx mcp
```

On a handshake version, open with `initialize`, then send requests without `_meta`:

```sh
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1
} | mx mcp
```
