# How mx works

## Sync

`mx sync` runs in the background and keeps a local copy of the mailbox in SQLite, with a full-text index.

- **New mail:** mx subscribes to Microsoft Graph change notifications for Inbox and Sent Items. They reach a local webhook through a Cloudflare quick tunnel that `cloudflared` opens. mx uses the `cloudflared` that `MX_CLOUDFLARED` names, or the one on `PATH`. Otherwise it downloads a pinned release and checks its sha256. Each notification starts a delta pass of that folder.
- **Fallback:** while notifications work, mx also polls every folder every 5 minutes. When they don't, it polls every 60 seconds and tries notifications again every 10 minutes.
- **Stopping:** on Windows, stopping sync also ends its `cloudflared`. A forced stop can't delete the Graph subscriptions, so they expire within 3 days, and the next sync start deletes any that remain.
- **Health:** `mx sync` records a heartbeat every minute. `mx status` and the read tools use it to tell whether sync is running and how old the mail is.

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

| Linux | Windows | Holds |
| --- | --- | --- |
| `$XDG_CONFIG_HOME/mx/config.json` | `%LOCALAPPDATA%\mx\config.json` | The client id and tenant from `mx login` |
| `$XDG_DATA_HOME/mx/` | `%LOCALAPPDATA%\mx\data\` | The mail store and a downloaded `cloudflared` |
| `$XDG_STATE_HOME/mx/` | `%LOCALAPPDATA%\mx\state\` | The sign-in file on machines without a secret store; the Windows sync log |
| `$XDG_CACHE_HOME/mx/` | `%LOCALAPPDATA%\mx\cache\` | Saved attachments |

On Linux the background service is the systemd user unit `mx-sync`. Its log is in the journal: `journalctl --user -u mx-sync -f`.

## Trying the MCP server by hand

mx speaks MCP 2026-07-28 over stdio. Each request carries its protocol version in `_meta`, and there is no handshake:

```sh
meta='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
{
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$meta}}"
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$meta}}"
  sleep 1
} | mx mcp
```
