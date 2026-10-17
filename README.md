# mx

mx keeps a local copy of a Microsoft 365 mailbox and lets an AI agent search, read, draft, send, file and flag that mail over MCP. It talks to Microsoft Graph with delegated `Mail.ReadWrite` and `Mail.Send`. Its delete only moves a message to Deleted Items.

## Install

`mx install` sets mx up for the signed-in user, without admin rights. It is safe to run again, for example after a new build.

1. It copies the binary it runs from to the install folder.
2. It registers `mx sync` to start at sign-in.
3. It registers `mx mcp` with each MCP client it finds: Claude Desktop on Windows, Claude Code when the `claude` CLI is on your `PATH`, and Codex. With the `codex` CLI it runs `codex mcp add`; without it, it appends a `[mcp_servers.mx]` section to `~/.codex/config.toml` when that file has none.
4. It runs `mx login` when there is no saved sign-in. Like `mx login`, it asks for a client id and a tenant once, or takes `--client-id` and `--tenant`, and saves them.
5. It starts `mx sync`.

### Linux

```sh
cd ~/Developer/mx
bun install
bun run build
./dist/mx-linux-x64 install
```

The binary goes to `~/.local/bin/mx`. The sync service is the systemd user unit `~/.config/systemd/user/mx-sync.service`. Follow its log with:

```sh
journalctl --user -u mx-sync -f
```

### Windows

Download `mx-windows-x64.exe` from the latest GitHub release, then run it from a terminal:

```powershell
Invoke-WebRequest https://github.com/PixelHabits/mx/releases/latest/download/mx-windows-x64.exe -OutFile mx-windows-x64.exe
.\mx-windows-x64.exe install
```

The exe is not code-signed, so SmartScreen warns before it runs. Choose More info, then Run anyway.

The binary goes to `%LOCALAPPDATA%\Programs\mx\mx.exe`. Next to it, `mxw.exe` is the same program marked as a Windows GUI program, so Windows starts it without a console window. The value `mx` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` starts `mxw.exe sync` at sign-in. Its log is `%LOCALAPPDATA%\mx\state\sync.log`.

Claude Desktop reads `mcpServers.mx` in `%APPDATA%\Claude\claude_desktop_config.json`. Quit and reopen Claude Desktop after the install so it starts mx.

### Uninstall

```sh
mx uninstall
```

It lists what it removes and asks first. `mx uninstall --yes` removes it all without asking; without a terminal, `--yes` is required. In this order, it:

1. Stops `mx sync` and removes its registration. Sync deletes its Graph subscriptions as it stops, while its sign-in is still saved.
2. Removes mx from Claude Desktop, Claude Code and Codex.
3. Deletes the installed binary, `config.json` with the client id and the tenant, the mail store, the saved sign-in, the attachment cache and the state folder.

Nothing of mx stays. To keep the sign-in, the mail and the settings, run `mx install` again instead.

## Updates

`mx sync` checks for a newer release when it starts and then once a day. `mx update` checks now. Both:

1. Fetch the manifest `latest.json` of the newest published release, `https://github.com/PixelHabits/mx/releases/latest/download/latest.json`, and its signature `latest.json.sig`.
2. Check the Ed25519 signature against the release key compiled into mx, and refuse a manifest the key did not sign.
3. Refuse a version that is not higher than the running one.
4. Download the binary for this platform and refuse it unless its size and sha256 match the manifest.
5. Replace the installed binary and restart `mx sync`. mx writes the new file next to the old one and renames it into place, so the installed path never holds part of a binary. Windows cannot replace a running exe, so there mx first renames `mx.exe` to `mx.old.exe`, and the next `mx sync` deletes it.

An update needs `mx install` first; it replaces the installed binary.

## How the sync service follows the mailbox

`mx sync` learns about new mail from Graph push notifications, and polls as the fallback.

1. It starts a local webhook on `127.0.0.1` and a Cloudflare quick tunnel to it with `cloudflared`. A new quick tunnel takes about 30 seconds to answer from the internet.
2. It subscribes to changes in Inbox and Sent Items. Graph posts a notification within seconds of a change, and mx runs a delta pass of that folder.
3. It renews the subscriptions every day, and checks the tunnel every 5 minutes. When cloudflared exits or the tunnel stops answering, mx starts a new tunnel, deletes the old subscriptions and subscribes again through it, since Graph cannot move a subscription's lifecycle notifications to a new address.
4. While push works, mx also polls every folder every 5 minutes. When push is down, for example because cloudflared cannot be found or downloaded, mx polls every 60 seconds and tries push again every 10 minutes.

The log says in one line each time push comes up or goes down. On start, mx deletes the subscriptions an earlier run left behind. On a clean stop, it deletes its own.

mx runs the `cloudflared` that `MX_CLOUDFLARED` names, or else the one on your `PATH`. Without either, it downloads cloudflared 2026.10.1 from Cloudflare's GitHub releases into its data folder and checks the file's sha256 first.

## When a command says "Run mx login."

Microsoft refused the saved sign-in, or there is none. Run `mx login` again. On Linux the service retries every 5 minutes, so it picks up the new sign-in by itself. On Windows, run `mx install` again to start sync.

## Files

| Linux | Windows | Holds |
| --- | --- | --- |
| `$XDG_CONFIG_HOME/mx/config.json` | `%LOCALAPPDATA%\mx\config.json` | The client id and the tenant `mx login` saved. |
| `$XDG_DATA_HOME/mx/mx.sqlite` | `%LOCALAPPDATA%\mx\data\mx.sqlite` | The messages, the folders and their delta links, and the full-text index. |
| `$XDG_DATA_HOME/mx/cloudflared/` | `%LOCALAPPDATA%\mx\data\cloudflared\` | The cloudflared release mx downloaded, when neither `MX_CLOUDFLARED` nor `PATH` has one. |
| `$XDG_STATE_HOME/mx/refresh-token` | | The refresh token, only on a machine without a secret store. The file has mode 0600. |
| | `%LOCALAPPDATA%\mx\state\sync.log` | The log of the background `mx sync`. |
| `$XDG_CACHE_HOME/mx/` | `%LOCALAPPDATA%\mx\cache\` | Attachments the `attachment` tool downloaded, one folder per message. |

On Linux, unset XDG variables fall back to `~/.config`, `~/.local/share`, `~/.local/state` and `~/.cache`.

mx checks at start that Bun's SQLite has FTS5, the full-text search it needs, and stops with a message when it does not.

## Tools

Messages carry short local ids such as `#12`. A message keeps its id when it moves between folders.

| Tool | Does |
| --- | --- |
| `search` | Finds messages by words in the subject, sender and new text, with optional `folder`, `from`, `since` and `limit`. |
| `thread` | Shows the whole conversation across folders, oldest first. |
| `message` | Shows headers and new text, or the whole body with `full=true`. |
| `attachment` | Lists a message's attachments in body order, or saves attachment `n` to the cache and answers its path. |
| `draft` | Creates a draft: `kind` is `new`, `reply`, `reply_all` or `forward`. A reply or forward quotes the conversation. `attach` takes local file paths. |
| `update_draft` | Changes a draft's recipients, subject or body, or attaches files. A new body replaces the whole body. |
| `delete_draft` | Moves a draft to Deleted Items. |
| `send` | Sends a draft, given `draft` and its current `to`, `cc`, `bcc` and `subject` repeated. Or sends a message at once from the same fields as `draft`. |
| `update` | Marks messages read or unread, flags them, sets their categories, or moves them to a folder other than Deleted Items and the folders in it. |
| `delete` | Moves messages to Deleted Items. |

Read tools answer from the local store. `message` with `full=true` and `attachment` read from Graph. Write tools change Graph first and then update the stored message.

`send` with a draft refuses to send when `to`, `cc`, `bcc` or `subject` differ from the draft's. Recipients match in any order and case, and a draft without Cc or Bcc needs an empty list. The repeated fields put every recipient and the subject in the client's approval prompt.

### Recommended approvals

The tools carry MCP hints: `readOnlyHint` on `search`, `thread`, `message` and `attachment`, and `destructiveHint` on every write but `draft`, since `update_draft` replaces a body, `update` moves mail, `delete_draft` and `delete` move it to Deleted Items, and `send` sends it. Set the client's permissions to:

- Allow `search`, `thread`, `message`, `attachment`, `draft`, `update_draft`, `delete_draft` and `update` without asking.
- Always ask for `send` and `delete`.

## Rebuild the search index

```sh
mx reindex
```

## Release

1. Raise `version` in `package.json` above the published one.
2. Set `MX_RELEASE_SIGNING_KEY` to the release signing key, an Ed25519 private key in PKCS #8 PEM. Its public half is `release/public-key.pem`, and every build compiles that in.
3. Run:

   ```sh
   bun run release
   ```

   It builds both binaries into `dist/`, writes the manifest `dist/latest.json` with each binary's release URL, size and sha256, and signs it into `dist/latest.json.sig`.
4. Create the GitHub release `v<version>` as a draft, attach `mx-linux-x64`, `mx-windows-x64.exe`, `latest.json` and `latest.json.sig`, then publish it. mx reads only the newest published release, so it never sees a release without its files.

## Develop

```sh
bun run typecheck
bun run check
bun run test
```

The tests run every command against an in-memory Microsoft in `tests/fake-microsoft.ts`, and talk to `mx mcp` over its stdio as a client does. `tests/fake-secrets.ts` stands in for `Bun.secrets`, so no test touches the system's secret store. `tests/fake-processes.ts` stands in for every program mx starts: its cloudflared opens quick tunnels on the fake internet in `tests/fake-push.ts`, where Graph validates the webhook and posts notifications to it. `tests/fake-releases.ts` serves releases signed with a throwaway Ed25519 key.

To try the server by hand, pipe MCP 2026-07-28 requests into it. Each request carries its protocol version in `_meta`, and there is no handshake:

```sh
meta='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
{
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$meta}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$meta}}"
  sleep 1
} | mx mcp
```
