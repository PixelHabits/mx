# mx

mx keeps a local copy of a Microsoft 365 mailbox and lets an AI agent search, read, draft, send, file and flag that mail over MCP. It talks to Microsoft Graph with delegated `Mail.ReadWrite` and `Mail.Send`. Its delete only moves a message to Deleted Items.

## Install

`mx install` sets mx up for the signed-in user, without admin rights. Run it again to reinstall, for example after a new build.

1. It asks which agents to set up, as a list where the agents whose config file exists start selected. Name them with `--agent` instead, once for each, as in `mx install --agent claude-code --agent codex`. Without a terminal, `--agent` is required.
2. It checks that each chosen agent's config file exists. When one is missing, it stops before it changes anything and says how to make the agent write it: open Claude Code or Codex once, or in Claude Desktop open Settings › Developer › Edit Config. Then run `mx install` again.
3. It copies the binary it runs from to the install folder.
4. It registers `mx sync` to start at sign-in.
5. It sets the `mx` entry in each chosen agent's config file to the installed binary with the argument `mcp`, and keeps everything else in the file.
6. It sets the [recommended approvals](#recommended-approvals) for each of mx's tools that has no approval yet, in Claude Code and Codex.
7. It runs `mx login` when there is no saved sign-in. Like `mx login`, it asks for a client id and a tenant once, or takes `--client-id` and `--tenant`, and saves them.
8. It starts `mx sync`.
9. It tells you to quit and reopen each agent it set up. An agent that stays open can save its old settings over the file and drop the `mx` entry.

| Agent | `--agent` | Config file | Entry |
| --- | --- | --- | --- |
| Claude Desktop, on Windows and macOS | `claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS | `mcpServers.mx` |
| Claude Code | `claude-code` | `~/.claude.json`, and `~/.claude/settings.json` for approvals; both in `$CLAUDE_CONFIG_DIR` when it is set | `mcpServers.mx`, the user scope, and `mcp__mx__<tool>` rules in `permissions` |
| Codex | `codex` | `$CODEX_HOME/config.toml`, by default `~/.codex/config.toml` | `[mcp_servers.mx]`, and `approval_mode` in `[mcp_servers.mx.tools.<tool>]` |

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

### Arch Linux

`packaging/arch/PKGBUILD` builds mx with Bun from the committed HEAD of this checkout:

```sh
cd ~/Developer/mx/packaging/arch
makepkg -si
mx install
```

The package owns `/usr/bin/mx` and the systemd user unit `/usr/lib/systemd/user/mx-sync.service`, so pacman installs, updates and removes them. Run from `/usr/bin/mx`, `mx install` registers that binary with each agent and enables the unit, and copies no binary and writes no unit. `mx update` refuses and says to update with pacman, and `mx sync` logs the same instead of updating. `mx uninstall` disables the unit and removes the rest of mx; `pacman -R mx` removes the package.

### Windows

Download `mx-windows-x64.exe` from the latest GitHub release, then run it from a terminal:

```powershell
Invoke-WebRequest https://github.com/PixelHabits/mx/releases/latest/download/mx-windows-x64.exe -OutFile mx-windows-x64.exe
.\mx-windows-x64.exe install
```

The exe is not code-signed, so SmartScreen warns before it runs. Choose More info, then Run anyway.

The binary goes to `%LOCALAPPDATA%\Programs\mx\mx.exe`. Next to it, `mxw.exe` is the same program marked as a Windows GUI program, so Windows starts it without a console window. The value `mx` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` starts `mxw.exe sync` at sign-in. Its log is `%LOCALAPPDATA%\mx\state\sync.log`.

### Uninstall

```sh
mx uninstall
```

It lists what it removes and asks first. `mx uninstall --yes` removes it all without asking; without a terminal, `--yes` is required. In this order, it:

1. Stops `mx sync` and removes its registration. Sync deletes its Graph subscriptions as it stops, while its sign-in is still saved.
2. Removes mx from every agent config file that has it: the `mx` entry in `mcpServers`, Codex's `[mcp_servers.mx]` with its tool tables, and every rule in the `allow`, `ask` and `deny` lists of Claude Code's user settings that names mx, as `mcp__mx`, `mcp__mx__<tool>` or a glob such as `mcp__mx__*`. A list it empties goes too. Project and local settings files stay as they are.
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

## Is it running?

```sh
mx status
```

It prints whether `mx sync` is running, when mail last synced, the mode, the version of `mx sync` and of the binary you ran, whether a sign-in is saved, whether a client id is set, the tenant, and the last error. The mode is `push` while Graph push notifications arrive, `poll` while push is down, and `starting` before either. `mx sync` writes this to the mail store every minute while it runs, however long a pass takes, and also after every pass and whenever its mode changes. `mx status` counts sync as running when it wrote within the last 3 minutes, and counts mail as out of date when no pass succeeded in the last 15 minutes. It exits with a non-zero code when sync is not running, mail is out of date, or sync reports an error. `mx sync --once` writes none of it.

The read tools, `search`, `thread`, `message` and `attachment`, put one line before their answer when the mail may be out of date: the sign-in expired, `mx sync` never ran or is not running, or mail last synced more than 15 minutes ago, even while `mx sync` runs. The line says how old the mail is and names the last error, if there is one. A sign-in that expired comes first. For example:

- `⚠ Sign-in expired. Run mx login.`
- `⚠ mx sync has never run. Run mx status.`
- `⚠ Mail last synced 3 h ago and mx sync is not running. Run mx status.`
- `⚠ Mail last synced 3 h ago. Last error: Microsoft Graph answered 503 ServiceUnavailable. Run mx status.`

The background `mx sync` logs to:

| Linux | Windows |
| --- | --- |
| the systemd journal: `journalctl --user -u mx-sync -f` | `%LOCALAPPDATA%\mx\state\sync.log` |

## When a command says "Run mx login."

Microsoft refused the saved sign-in, or there is none. Run `mx login` again. On Linux the service retries every 5 minutes, so it picks up the new sign-in by itself. On Windows, run `mx install` again to start sync.

## Files

| Linux | Windows | Holds |
| --- | --- | --- |
| `$XDG_CONFIG_HOME/mx/config.json` | `%LOCALAPPDATA%\mx\config.json` | The client id and the tenant `mx login` saved. |
| `$XDG_DATA_HOME/mx/mx.sqlite` | `%LOCALAPPDATA%\mx\data\mx.sqlite` | The messages, the folders and their delta links, the full-text index, and the heartbeat `mx sync` writes for `mx status`. |
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

The tools carry MCP hints: `readOnlyHint` on `search`, `thread`, `message` and `attachment`, and `destructiveHint` on every write but `draft`, since `update_draft` replaces a body, `update` moves mail, `delete_draft` and `delete` move it to Deleted Items, and `send` sends it. The hints do not set the approvals. mx recommends:

- Allow `search`, `thread`, `message`, `attachment`, `draft`, `update_draft`, `delete_draft` and `update` without asking.
- Always ask for `send` and `delete`.

`mx install` sets these for each tool that has no approval yet, and keeps every approval you set:

| Agent | Allow without asking | Always ask | A tool has an approval when |
| --- | --- | --- | --- |
| Claude Code | `mcp__mx__<tool>` in `permissions.allow` of `~/.claude/settings.json` | `mcp__mx__<tool>` in `permissions.ask` | A rule in `allow`, `ask` or `deny` covers it: `mcp__mx__<tool>`, `mcp__mx`, or a glob such as `mcp__mx__*` |
| Codex | `approval_mode = "approve"` in `[mcp_servers.mx.tools.<tool>]` | `approval_mode = "prompt"` | The tool's table sets `approval_mode`, or `[mcp_servers.mx]` sets `default_tools_approval_mode` |

Claude Code checks `deny`, then `ask`, then `allow`, and the first rule that matches decides. Claude Desktop keeps tool approvals outside its config file, so mx sets none there.

With `approval_policy = "never"`, Codex approves a `prompt` tool without asking when its sandbox is off, external, or allows writes to the whole disk, as `sandbox_mode = "danger-full-access"` does. There, "always ask" is not guaranteed. Codex 0.163.0 decides this in `mcp_permission_prompt_is_auto_approved`, in `codex-rs/codex-mcp/src/mcp/mod.rs`.

### Changing approvals

The recommended approvals are defaults. Change them in each agent's own settings, and a reinstall keeps them.

Warning: allowing `send` without asking lets an agent send email as you without review, including when an incoming email tells it to.

- **Claude Code:** run `/permissions`, or edit `~/.claude/settings.json` and move `mcp__mx__send` or `mcp__mx__delete` from `permissions.ask` to `permissions.allow`. An `ask` rule from any settings file outranks an `allow` rule, so the rule must leave `ask`. The prompt's "Yes, and don't ask again" option saves an `allow` rule to `.claude/settings.local.json` in the repository, which does not outrank the `ask` rule in `~/.claude/settings.json`.
- **Codex:** in `config.toml`, set `approval_mode = "approve"` in `[mcp_servers.mx.tools.send]` or `[mcp_servers.mx.tools.delete]`. Codex then runs the tool without asking under any `approval_policy`.
- **Claude Desktop:** choose to allow the tool always when its approval prompt asks.

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

   It builds both binaries and their third-party notices into `dist/`, writes the manifest `dist/latest.json` with each binary's release URL, size and sha256, and signs it into `dist/latest.json.sig`.
4. Create the GitHub release `v<version>` as a draft, attach `mx-linux-x64`, `mx-windows-x64.exe`, `THIRD_PARTY_NOTICES`, `latest.json` and `latest.json.sig`, then publish it. mx reads only the newest published release, so it never sees a release without its files.

## Develop

```sh
bun run typecheck
bun run check
bun run test
```

The tests run every command against an in-memory Microsoft in `tests/fake-microsoft.ts`, and talk to `mx mcp` over its stdio as a client does. `tests/fake-secrets.ts` stands in for `Bun.secrets`, so only one test touches the system's secret store: on Windows, it saves to Credential Manager and then puts back what was there. `tests/fake-processes.ts` stands in for every program mx starts: its cloudflared opens quick tunnels on the fake internet in `tests/fake-push.ts`, where Graph validates the webhook and posts notifications to it. `tests/fake-releases.ts` serves releases signed with a throwaway Ed25519 key.

The tests run on Linux and on Windows, and skip a test of what only the other has, such as systemd. On Windows they also run `dist/mx-windows-x64.exe`, so build it first with `bun run build windows-x64`. CI builds it on Linux, as a release does.

To try the server by hand, pipe MCP 2026-07-28 requests into it. Each request carries its protocol version in `_meta`, and there is no handshake:

```sh
meta='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
{
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$meta}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$meta}}"
  sleep 1
} | mx mcp
```
