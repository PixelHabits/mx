# mx

Your Microsoft 365 mailbox, for your AI agent.

mx gives Claude Desktop, Claude Code and Codex your mail through the Model Context Protocol (MCP). Your agent can search and read whole conversations, including what you sent, draft and send replies, and keep your inbox in order. mx keeps a copy of your mailbox on your machine, so reading is fast and costs your agent few tokens, and it hears about new mail within seconds.

## What your agent can do

- Search your mail and read whole threads across folders, including your own replies.
- Read attachments and inline images.
- Draft new messages, replies, reply-alls and forwards, with attachments.
- Send mail. By default your agent asks you first, every time.
- Mark mail read, flag it, categorize it and move it between folders.
- Delete mail. It goes to Deleted Items, so you can always get it back.

## Install

mx runs on Windows and Linux (x64). It installs for your user account and needs no admin rights.

### Windows

```powershell
Invoke-WebRequest https://github.com/PixelHabits/mx/releases/latest/download/mx-windows-x64.exe -OutFile mx-windows-x64.exe
.\mx-windows-x64.exe install
```

The exe is not code-signed, so Windows SmartScreen warns you the first time. Choose **More info**, then **Run anyway**.

mx installs itself to `%LOCALAPPDATA%\Programs\mx` and adds that folder to your PATH. Open a new terminal to run `mx`.

### Linux

```sh
curl -LO https://github.com/PixelHabits/mx/releases/latest/download/mx-linux-x64
chmod +x mx-linux-x64
./mx-linux-x64 install
```

mx installs itself to `~/.local/bin/mx`. Make sure `~/.local/bin` is on your PATH.

### Arch Linux

```sh
git clone https://github.com/PixelHabits/mx.git
cd mx/packaging/arch
makepkg -si
mx install
```

pacman then updates mx. To remove it, run `mx uninstall` first, then `pacman -R mx`.

### What `mx install` does

1. Asks which agents to set up: Claude Desktop, Claude Code or Codex. You can also name them with `--agent`.
2. Signs you in to Microsoft. It asks once for a client id and a tenant, or takes `--client-id` and `--tenant`.
3. Copies your mailbox the first time, showing how many messages it has read and about how long is left. This can take a while for a large mailbox. You can stop it with Ctrl-C, and the next `mx install` continues where it stopped.
4. Starts mx in the background, and again each time you sign in to your computer.
5. Tells you to restart the agents it set up. Do that, and mx is ready.

mx asks Microsoft for these delegated permissions: `Mail.ReadWrite`, `Mail.Send` and `offline_access`.

Run `mx install` again at any time to reinstall or to add an agent. It keeps your settings.

## Using it

Ask your agent about your mail in plain words:

- "What did the vendor say in their last email, and did I reply?"
- "Draft a reply to that thread saying we can meet Thursday."
- "Flag everything from the bank this week."

Your agent uses these tools:

| Tool | What it does |
| --- | --- |
| `search` | Finds conversations by words, sender, folder and date, best match first. Each conversation shows once. |
| `thread` | Shows a whole conversation, oldest first. |
| `message` | Shows one message. |
| `attachment` | Lists a message's attachments, or saves one. |
| `draft` | Creates a new message, reply, reply-all or forward. |
| `update_draft` | Changes a draft. |
| `delete_draft` | Moves a draft to Deleted Items. |
| `send` | Sends a draft, or a new message. |
| `update` | Marks, flags, categorizes or moves messages. |
| `delete` | Moves messages to Deleted Items. |

## Approvals

`mx install` sets these defaults in Claude Code and Codex:

- **Asks you first:** `send` and `delete`.
- **Runs without asking:** everything else.

When your agent sends a draft, the approval prompt shows every recipient and the subject.

Change the defaults in your agent's own settings. A reinstall keeps your changes.

- **Claude Code:** run `/permissions`, or move a rule such as `mcp__mx__send` from `ask` to `allow` in `~/.claude/settings.json`.
- **Codex:** set `approval_mode = "approve"` under `[mcp_servers.mx.tools.send]` in `~/.codex/config.toml`.
- **Claude Desktop:** choose to always allow the tool when it asks.

> **Warning:** if you let `send` run without asking, your agent can send email as you without your review. That includes when an email it reads tells it to.

## Is it working?

```sh
mx status
```

`mx status` says whether mx is running in the background, when your mail last synced, and any error. Once a day, mx also checks its copy against your mailbox and repairs anything that drifted.

When your mail may be out of date, your agent sees a warning line before its answer, such as `⚠ Mail last synced 3 h ago and mx sync is not running. Run mx status.` If the warning says `Sign-in expired. Run mx login.`, run `mx login`. mx restarts its background sync, and your agents use the new sign-in from their next request.

## Updates

mx updates itself from this repository's GitHub releases. It checks once a day and installs only releases signed with the project's release key. To check now, run `mx update`. If you installed with pacman, update with pacman instead.

## Privacy and security

- **Your mail stays on your machine.** mx keeps a copy of your mailbox in a local database and sends your mail nowhere but Microsoft. It also contacts GitHub to check for updates and Cloudflare for new-mail alerts.
- **Your sign-in is stored in your system's secret store:** Windows Credential Manager, or the Secret Service on Linux. On a Linux machine with no secret store, mx keeps it in a file only your user can read.
- **New-mail alerts** come from Microsoft through a temporary Cloudflare tunnel to your machine. They carry only message ids, and mx checks a secret on each one. If the tunnel is unavailable, mx checks for mail every minute instead.
- **Releases are signed and attested.** Check a download with `gh attestation verify mx-linux-x64 --repo PixelHabits/mx`.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Uninstall

```sh
mx uninstall
```

mx lists what it will remove and asks first. It removes everything: the program, its entries in your agents' settings, your saved sign-in and your local copy of your mail. On Windows it also takes mx off your PATH. Your mailbox in Microsoft 365 is not touched.

Quit your agents first. If one is still running mx, uninstall tells you which files to delete after you quit it.

## Build from source

You need [Bun](https://bun.com).

```sh
bun install
bun run build
bun run test
```

[docs/how-it-works.md](docs/how-it-works.md) explains how mx syncs, updates and stores your mail. [RELEASING.md](RELEASING.md) explains how releases are made. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE). The binaries also include Bun and other open-source components; see `THIRD_PARTY_NOTICES` in each release.
