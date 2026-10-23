# How mx works

## Sync

`mx sync` runs in the background and keeps a local copy of every account's mailbox in SQLite, with a full-text index.

- **Accounts:** one `mx sync` follows every account that config.json names. Each account has its own sign-in, subscriptions, delta passes, self-check and status, and all of them share one tunnel and one store. With several accounts, each sync line starts with the account's alias, such as `work: Synced 12 folders: …`.
- **New mail:** mx subscribes to Microsoft Graph change notifications for Inbox and Sent Items. They reach a local webhook through a Cloudflare quick tunnel that `cloudflared` opens. mx runs only `cloudflared` 2026.10.2 or newer, the first release that rejects the compromised eMudhra intermediate certificates. mx uses the `cloudflared` that `MX_CLOUDFLARED` names. If that one reports an older version, or a version mx can't read, push is unavailable. Without `MX_CLOUDFLARED`, mx uses the one on `PATH` if it reports 2026.10.2 or newer. Otherwise it downloads a pinned release and checks its sha256. On macOS that release is a tarball, and mx takes `cloudflared` out of it. Each notification starts a delta pass of that folder.
- **First sync:** `mx install` signs in every account first. Then it runs the first sync of each account that has not finished one, in the foreground, before it starts `mx sync`. The accounts sync at the same time, and each shows its progress on a line of its own, from each folder's message count. Each folder's delta link is saved when the folder finishes, so a stopped first sync keeps the finished folders and the next `mx install` reads only the rest. A folder that was part way through starts over. Whether the first sync finishes, fails or is stopped, `mx install` ends by starting `mx sync`, which carries on from there. An account that `mx login` adds gets its first sync from `mx sync` in the background, and `mx status` shows how many of its folders are done.
- **Folders at once:** a pass syncs 3 folders of an account at a time. Microsoft Graph allows 4 concurrent requests per app and mailbox, so one stays free for `mx mcp`. Accounts sync side by side.
- **Self-check:** after its first pass, and then once a day, `mx sync` compares every folder's message ids with Graph's. It adds messages the delta missed, refiles messages stored in the wrong folder, removes messages Graph no longer has, and drops deleted folders. It logs one line, such as `Reconciled 12 folders: 0 added, 0 refiled, 0 removed.`, and delta passes wait while it runs. A check that fails runs again an hour later.
- **Moves:** a delta page never moves a stored message out of the folder it is filed in. When a page and the store disagree, mx asks Graph where the message is now. Lookups from `mx sync` and `mx mcp` are applied in the order they began, so an older answer never overwrites a newer one. A delta entry that carries only the properties that changed is looked up by id the same way.
- **Refusals:** a folder or message that Graph refuses, or a page that mx cannot read, is skipped and shown as the last error in `mx status`, and sync carries on. The next folder listing drops a folder that is gone. Only an expired sign-in or a failing secret store stops an account, and the other accounts go on. `mx sync` stops when every account has stopped.
- **Fallback:** while notifications work, mx also polls every folder every 5 minutes. When they don't, it polls every 60 seconds and tries notifications again every 10 minutes.
- **Stopping:** on Windows and macOS, stopping sync also ends its `cloudflared`. A forced stop can't delete the Graph subscriptions, so they expire within 3 days, and the next sync start deletes any that remain.
- **Health:** `mx sync` records a heartbeat every minute, and each account's mode, last success and last error after every pass. `mx status` and the read tools use them to tell whether sync is running and how old each account's mail is.
- **Removed accounts:** when it starts, `mx sync` drops the folders and mail of any account that config.json no longer names. An `mx sync` that ran on while `mx logout` removed an account can leave some of that account's mail.

## Store

The mail store is one SQLite file, `mx.sqlite`, in the data folder. It holds the folders with their delta links, one row per message, the local id each message got, and the full-text index.

- **Accounts:** every folder is filed under an account id, and a message belongs to the account of its folder. Deleting an account's folders deletes its mail. The `accounts` table holds how `mx sync` follows each account. Local ids are unique across accounts, so `#12` names one message in one account. The store holds no aliases; config.json does.
- **Migrations:** each change to the store's schema is a numbered migration built into the binary. When it opens the store, mx runs the migrations the store has not recorded, in one transaction, and records each one in the `effect_sql_migrations` table. Migration 1 is the schema of mx 0.1.0, so a store that 0.1.0 created records it and keeps all its mail.
- **Newer stores:** a store that records a migration this mx does not know was written by a newer mx. mx refuses to open it, changes nothing, and says `This mail store was written by a newer mx. Run mx update.` `mx update` and `mx uninstall` still work.
- **Local ids:** apart from the `#N` id each message got, the store mirrors the mailbox. No migration changes the local ids. A migration that cannot convert the stored mail may clear every folder's delta link instead, so the next pass reads every folder again.
- **Transactions:** each mx process opens one connection to the store. A write runs in a transaction that holds the connection until it commits, and SQLite waits up to 5 seconds for a write lock that the other mx process holds.

## When a message is gone

Each tool sends its requests about a message to Graph with the access token of the message's own account. When a tool's request to Graph, including a draft tool's, answers 404 for a stored message, mx looks the message up by its id in that account. If Graph still has it, mx refiles it where Graph says and returns the error. If Graph no longer has it, mx removes it from the store, and the tool answers, for example, `#12 is no longer in the mailbox.`

## Search

`search` uses an SQLite FTS5 index over the subject, sender and new text. The porter stemmer matches word forms, so "approve" also finds "approved" and "approval". With a query, results are ranked by bm25, weighting the subject 10, the sender 2 and the body 1, with newer messages first among equals. Without a query, they are newest first. Each conversation appears once, by its best match, with `(+N in thread)` when it has more messages. Search covers every account unless `account` names one, and a conversation in two accounts appears once in each. `mx reindex` rebuilds the index from the stored messages.

## Query

`query` runs one SQL SELECT that the agent writes, so it can count, group and join mail instead of reading many search lines.

- **Views:** the SQL reads three views. `mail` has one row per message, `folders` has each folder's path with its message and unread counts, and `conversations` has one row per conversation of an account with its newest message. Each view has an `account` column with the account's alias. Times are UTC ISO 8601 text. Message bodies aren't in the views; `search` finds words in them.
- **One account:** with `account`, the views hold that account's rows alone.
- **Read-only:** each query runs in a process of its own, `mx query-worker`, which opens the store read-only, so SQLite refuses every write. mx wraps the SQL in its own `SELECT * FROM (…)`, so SQLite accepts nothing but one SELECT: no `INSERT`, `ATTACH`, `PRAGMA` or second statement. The tool returns SQLite's error as it is.
- **Limits:** an answer has at most 200 rows and 20,000 characters, and each value but an Outlook link is cut at 200 characters. Its last line says when a limit cut it short. mx stops a query that runs longer than 10 seconds.
- **Schema:** the query process creates the views each time it starts, so the store's tables can change while the views stay the same. It reads the aliases from config.json each time, so a renamed account shows its new alias at once.

## Accounts and sign-in

config.json names the accounts, oldest first. Each account has:

- `id`: its number, under which the store files its folders and the secret store keeps its sign-in. A new account gets the highest id plus one.
- `alias`: the name it shows as and that commands take.
- `clientId` and `tenant`: what it signs in with.
- `address`, `tid` and `oid`: who signed in, from the id token of its last `mx login`. mx refuses to add a mailbox whose `tid` and `oid` another account already has.

A config.json from mx 0.3.0 or earlier holds only a client id and a tenant. mx reads it as account 1, aliased after its tenant, and leaves the file as it is until a command such as `mx login` or `mx rename` writes it again.

Each account's saved sign-in is one record in the system's secret store, or in a file only the user can read where no secret store exists. Account 1's record is `refresh-token`, as in earlier releases, and each other account's is `refresh-token-<id>`. A record holds the refresh token with the client id and tenant it belongs to, and an id that each `mx login` renews. Every Graph request reads the record of its account, so a running `mx mcp` or `mx sync` switches to a new sign-in on its next request and never uses an old one. `mx login` also restarts `mx sync`.

On macOS the record is an item in the Keychain. The Keychain lets a program delete an item only when a program with the same file name saved it, and only while the deleting program's file is on disk. So `mx install` run from another file, such as the downloaded `mx-darwin-arm64`, copies itself to `~/.local/bin/mx` and lets that copy finish the install and save each sign-in. `mx uninstall` deletes the sign-ins before it removes mx's folders, where config.json names the accounts, and removes the program last. When the Keychain still refuses a delete, as for a sign-in a program of another name saved, mx stops and prints the `security delete-generic-password` command that deletes that record. Run it, then run the mx command again.

`mx mcp` reads config.json as each tool call starts, so a call sees an account that was added or renamed after it started. Its instructions name the accounts as config.json named them when it started, so restart your agents after you add or remove one.

`mx logout --account <alias>` removes an account in this order:

1. It deletes the account's folders and status from the store, and its mail with them.
2. It deletes the account's Graph subscriptions with the account's own sign-in. When the account has no working sign-in, as on a rerun after step 3, nothing can delete them, and they expire within 3 days.
3. It deletes the account's saved sign-in.
4. It removes the account from config.json.
5. It restarts `mx sync`, which then no longer follows the account.

config.json names the account until step 4. A logout that stops before then leaves the account in config.json, so `mx logout --account <alias>` run again, or `mx uninstall`, finds the account and removes the rest. Nothing that is already gone stops the rerun. Until step 5, the `mx sync` that runs still follows the account and can store some of its mail again. The restarted `mx sync` drops that mail as it starts.

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
| `$XDG_CONFIG_HOME/mx/config.json` | `~/Library/Application Support/mx/config.json` | `%APPDATA%\mx\config.json` | The accounts, each with its alias, address, client id and tenant |
| `$XDG_DATA_HOME/mx/` | `~/Library/Application Support/mx/` | `%APPDATA%\mx\` | The mail store and a downloaded `cloudflared` |
| `$XDG_STATE_HOME/mx/` | `~/Library/Application Support/mx/` | `%LOCALAPPDATA%\mx\` | `log.sqlite`, the log of every tool call, prompt and sync line that `mx log` prints; each account's sign-in file on machines without a secret store; on macOS, `sync.log` with what mx prints when `mx sync` fails |
| `$XDG_CACHE_HOME/mx/` | `~/Library/Caches/mx/` | `%LOCALAPPDATA%\mx\Cache\` | Saved attachments |

An absolute `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` or `XDG_CACHE_HOME` moves that folder on macOS and Windows too.

On Windows, Claude Desktop from the Microsoft Store keeps its config in `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json`. Some of its builds keep it inside their app package instead, in `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`. `mx install` and `mx uninstall` change each of these files that exists, and also `%APPDATA%\Claude\claude_desktop_config.json` when it exists.

On Linux the background service is the systemd user unit `mx-sync`. It writes its log lines to `log.sqlite` and to the journal. Follow them with `mx log --sync --follow` or `journalctl --user -u mx-sync -f`.

On macOS it is the LaunchAgent `io.github.pixelhabits.mx.sync`, in `~/Library/LaunchAgents/io.github.pixelhabits.mx.sync.plist`. launchd starts it at sign-in, and again after it fails, at most once every 5 minutes. It writes its log lines to `log.sqlite` alone, since launchd never caps `sync.log` in the state folder. That file keeps only what mx prints when it fails. Follow the log lines with `mx log --sync --follow`.

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
