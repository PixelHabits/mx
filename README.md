# mx

Your Microsoft 365 mailbox, for your AI agent.

mx gives Claude Desktop, Claude Code and Codex your mail through the Model Context Protocol (MCP). Your agent can search and read whole conversations, including what you sent, draft and send replies, and keep your inbox in order. mx keeps a copy of your mailbox on your machine, so reading is fast and costs your agent few tokens, and it hears about new mail within seconds.

## What your agent can do

- Search your mail and read whole threads across folders, including your own replies.
- Read attachments and inline images.
- Draft new messages, replies, reply-alls and forwards, with attachments.
- Send mail. By default your agent asks you first, every time.
- Mark mail read, flag it, categorize it and move it between folders.
- Create, rename and move folders.
- Delete mail and folders. They go to Deleted Items, so you can always get them back.

## Install

mx runs on macOS, Windows and Linux (x64). It installs for your user account and needs no admin rights.

### Windows

Download [mx-windows-x64.exe](https://github.com/PixelHabits/mx/releases/latest/download/mx-windows-x64.exe) and double-click it. mx asks which agents should use it, signs you in to Microsoft and syncs your mail once. When it shows "Press Enter to close.", press Enter.

Or install it from PowerShell:

```powershell
Invoke-WebRequest https://github.com/PixelHabits/mx/releases/latest/download/mx-windows-x64.exe -OutFile mx-windows-x64.exe
.\mx-windows-x64.exe install
```

The exe isn't code-signed yet (coming soon), so Windows SmartScreen warns you the first time. Choose **More info**, then **Run anyway**.

mx installs itself to `%LOCALAPPDATA%\Programs\mx` and adds that folder to your PATH. Open a new terminal to run `mx`.

### macOS

On a Mac with Apple silicon:

```sh
curl -LO https://github.com/PixelHabits/mx/releases/latest/download/mx-darwin-arm64
chmod +x mx-darwin-arm64
./mx-darwin-arm64 install
```

On a Mac with an Intel processor, use `mx-darwin-x64` instead.

The macOS binaries aren't signed or notarized yet (coming soon). A file downloaded with `curl` as above runs normally. If you download it in a browser instead, don't open it from Finder: the browser drops the file's executable permission, so Finder opens it in TextEdit. Run these in Terminal from the folder you saved it to:

```sh
chmod +x mx-darwin-arm64
xattr -d com.apple.quarantine mx-darwin-arm64
./mx-darwin-arm64 install
```

mx installs itself to `~/.local/bin/mx`. If that folder is not on your PATH, `mx install` prints the line to add to `~/.zprofile`. Open a new terminal to run `mx`.

### Linux

```sh
curl -LO https://github.com/PixelHabits/mx/releases/latest/download/mx-linux-x64
chmod +x mx-linux-x64
./mx-linux-x64 install
```

mx installs itself to `~/.local/bin/mx`. If that folder is not on your PATH, `mx install` prints the line to add to `~/.bashrc`.

### Arch Linux

mx is in the AUR as `mx-mail-bin`. Install it with an AUR helper such as yay, then set it up:

```sh
yay -S mx-mail-bin
mx install
```

Your AUR helper then updates mx, as with `yay -Syu`. To remove it, run `mx uninstall` first, then `pacman -R mx-mail-bin`.

To build the package from source instead:

```sh
git clone https://github.com/PixelHabits/mx.git
cd mx/packaging/arch
makepkg -si
mx install
```

This installs the package `mx-mail`. To update it, pull and run `makepkg -si` again. To remove it, run `mx uninstall` first, then `pacman -R mx-mail`.

### What `mx install` does

1. Asks which agents to set up: Claude Desktop, Claude Code or Codex. You can also name them with `--agent`.
2. Signs you in to Microsoft. It asks once for a client id and a tenant, or takes `--client-id` and `--tenant`. It copies the sign-in code, and opens your browser when you press Enter.
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
| `query` | Counts, groups and filters mail with one read-only SQL query. |
| `thread` | Shows a whole conversation, oldest first. |
| `message` | Shows one message. |
| `attachment` | Lists a message's attachments, or saves one. |
| `draft` | Creates a new message, reply, reply-all or forward. |
| `update_draft` | Changes a draft. |
| `delete_draft` | Moves a draft to Deleted Items. |
| `send` | Sends a draft, or a new message. |
| `update` | Marks, flags, categorizes or moves messages. |
| `delete` | Moves messages to Deleted Items. |
| `folder` | Creates, renames or moves a folder. |
| `delete_folder` | Moves a folder, with everything in it, to Deleted Items. |

### Triage and interview

mx also offers two ready-made requests:

- **triage** reviews your new mail and reports what needs your reply, other actions, and failing systems, then counts the rest. It changes nothing until you agree.
- **interview** looks over your last 30 days of mail, then asks you how you work: whose mail matters, what is noise, how you file mail. It saves your answers to your agent's memory when it can, so later triage follows them.

In Claude Code, type `/mx:triage` or `/mx:interview`. You can give triage a start date, as in `/mcp__mx__triage 2026-10-01`. In Claude Desktop, choose **+**, then **Add from mx**. Codex has no ready-made requests, so ask it in plain words, such as "triage my mail".

## Approvals

`mx install` sets these defaults in Claude Code and Codex:

- **Asks you first:** `send`, `delete` and `delete_folder`.
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

To see what your agents asked mx and what mx answered, run `mx log`. It prints the last 20 tool calls, oldest first: when, which agent, what it sent, the whole answer, and how long it took. `--tool send` shows one tool, `--since 2026-10-19` starts at a date, `--sync` adds the background sync's own lines, and `--follow` keeps printing new calls as they arrive.

## Updates

mx updates itself from this repository's GitHub releases. It checks once a day and installs only releases signed with the project's release key. To check now, run `mx update`. If you installed mx from the AUR or built the Arch package, update it that way instead.

## Privacy and security

- **Your mail stays on your machine.** mx keeps a copy of your mailbox in a local database and sends your mail nowhere but Microsoft. It also contacts GitHub to check for updates and Cloudflare for new-mail alerts.
- **Your sign-in is stored in your system's secret store:** the Keychain on macOS, Windows Credential Manager, or the Secret Service on Linux. On a Linux machine with no secret store, mx keeps it in a file only your user can read.
- **mx keeps a log of every tool call**, with what your agent asked and what mx answered, in `log.sqlite` in its state folder. The log is capped at 50 MB, only your user can read it, and it never leaves your machine. `mx uninstall` removes it.
- **New-mail alerts** come from Microsoft through a temporary Cloudflare tunnel to your machine. They carry only message ids, and mx checks a secret on each one. If the tunnel is unavailable, mx checks for mail every minute instead.
- **Releases are attested, and updates are signed.** Check a download with `gh attestation verify mx-linux-x64 --repo PixelHabits/mx`. mx installs only updates signed with the project's release key. Code signing for the Windows and macOS binaries is coming soon.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Uninstall

```sh
mx uninstall
```

mx lists what it will remove and asks first. It removes everything: the program, its entries in your agents' settings, your saved sign-in, your local copy of your mail and the log of tool calls. On Windows it also takes mx off your PATH. Your mailbox in Microsoft 365 is not touched.

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
