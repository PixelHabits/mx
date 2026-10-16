# mx

mx keeps a local copy of a Microsoft 365 mailbox and lets an AI agent search, read, draft, send, file and flag that mail over MCP. It talks to Microsoft Graph with delegated `Mail.ReadWrite` and `Mail.Send`. Its delete only moves a message to Deleted Items.

## Install

1. Build the binary and put it on your path:

   ```sh
   cd ~/Developer/mx
   bun install
   bun run build
   install -Dm755 dist/mx ~/.local/bin/mx
   ```

2. Sign in:

   ```sh
   mx login
   ```

   `mx login` asks for a client id and a tenant once, or takes `--client-id` and `--tenant`, and saves them. The tenant is `organizations`, which Enter keeps, a tenant id, or a domain such as `contoso.com`. Then it prints a URL and a code. Open the URL, enter the code and sign in with your work account. mx saves the refresh token in the system's secret store: Windows Credential Manager, the macOS Keychain, or the Secret Service on Linux. On a Linux machine without a Secret Service, it saves the token in a file only you can read.

3. Run the first sync by hand and check its summary:

   ```sh
   mx sync --once
   ```

4. Start the sync service, which runs a pass every 60 seconds:

   ```sh
   install -Dm644 systemd/mx-sync.service ~/.config/systemd/user/mx-sync.service
   systemctl --user daemon-reload
   systemctl --user enable --now mx-sync.service
   journalctl --user -u mx-sync -f
   ```

5. Register the MCP server with Claude Code and Codex:

   ```sh
   claude mcp add --scope user mx -- ~/.local/bin/mx mcp
   codex mcp add mx -- ~/.local/bin/mx mcp
   ```

## When a command says "Run mx login."

Microsoft refused the saved sign-in, or there is none. Run `mx login` again. The service retries every 5 minutes, so it picks up the new sign-in by itself.

## Files

| Path | Holds |
| --- | --- |
| `$XDG_CONFIG_HOME/mx/config.json` | The client id and the tenant `mx login` saved. |
| `$XDG_DATA_HOME/mx/mx.sqlite` | The messages, the folders and their delta links, and the full-text index. |
| `$XDG_STATE_HOME/mx/refresh-token` | The refresh token, only on a machine without a secret store. The file has mode 0600. |
| `$XDG_CACHE_HOME/mx/` | Attachments the `attachment` tool downloaded, one folder per message. |

Unset variables fall back to `~/.config`, `~/.local/share`, `~/.local/state` and `~/.cache`.

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

## Develop

```sh
bun run typecheck
bun run check
bun run test
```

The tests run every command against an in-memory Microsoft in `tests/fake-microsoft.ts`, and talk to `mx mcp` over its stdio as a client does. `tests/fake-secrets.ts` stands in for `Bun.secrets`, so no test touches the system's secret store.

To try the server by hand, pipe MCP 2026-07-28 requests into it. Each request carries its protocol version in `_meta`, and there is no handshake:

```sh
meta='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
{
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$meta}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$meta}}"
  sleep 1
} | mx mcp
```
