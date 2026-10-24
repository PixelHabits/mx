# Changelog

## [0.4.1](https://github.com/PixelHabits/mx/compare/v0.4.0...v0.4.1) (2026-10-24)


### Bug Fixes

* save and delete macOS Keychain sign-ins from the installed mx, and delete them before the binary ([#14](https://github.com/PixelHabits/mx/issues/14)) ([243c692](https://github.com/PixelHabits/mx/commit/243c692cd7700c91f9b88a73a0c35893c19151ca))

## [0.4.0](https://github.com/PixelHabits/mx/compare/v0.3.0...v0.4.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* On Windows and macOS, mx now looks for its sign-in settings, its mail store and its logs in new folders. On Windows, the client id and tenant and the mail store are in %APPDATA%\mx, the logs in %LOCALAPPDATA%\mx, and saved attachments in %LOCALAPPDATA%\mx\Cache. On macOS, the client id and tenant, the mail store and the logs are in ~/Library/Application Support/mx. To move to this version, first run mx uninstall with the version you have now. Then install this version, and run mx install and mx login again. Run mx uninstall first, because this version does not know the old folders.

### Features

* adopt Effect 4.0.6, with folders from UserDirectories and terminal checks from TerminalCapabilities ([#11](https://github.com/PixelHabits/mx/issues/11)) ([67dbc4f](https://github.com/PixelHabits/mx/commit/67dbc4fe74d87c181502bed0d1407ede037dcdbb))
* **mcp:** give each message a link that opens it in Outlook on the web ([ce41978](https://github.com/PixelHabits/mx/commit/ce41978ea52fddfed926f5a739420e6ca5e9c2e7))
* **mcp:** write mail bodies as HTML rendered from Markdown, with an html format for raw HTML ([#8](https://github.com/PixelHabits/mx/issues/8)) ([6ac51d5](https://github.com/PixelHabits/mx/commit/6ac51d584032694ab5f1bee50a553b9154142955))
* several Microsoft 365 accounts in one mx ([#7](https://github.com/PixelHabits/mx/issues/7)) ([6dc7af0](https://github.com/PixelHabits/mx/commit/6dc7af0e9f88f90d4ecf8a08fb3669cbee0df061))


### Bug Fixes

* **install:** find Claude Desktop's config in Claude-Data on Windows ([#13](https://github.com/PixelHabits/mx/issues/13)) ([ceb3056](https://github.com/PixelHabits/mx/commit/ceb3056eb587260b5896c2f1e921953188d8aac1))
* **push:** run only cloudflared 2026.10.2 or newer, and pin 2026.10.3 ([#10](https://github.com/PixelHabits/mx/issues/10)) ([5ca160d](https://github.com/PixelHabits/mx/commit/5ca160dfe7a8fd6a84e558438c43cc4bf8443cb9))

## [0.3.0](https://github.com/PixelHabits/mx/compare/v0.2.0...v0.3.0) (2026-10-19)


### Features

* **log:** keep a log of every tool call in log.sqlite, and show it with mx log ([d38c46c](https://github.com/PixelHabits/mx/commit/d38c46c47bebf7d349cc59f72a417a16daccac4b))
* **mcp:** create, rename and move folders, and move a folder to Deleted Items ([accf68e](https://github.com/PixelHabits/mx/commit/accf68ecdac4664d8dbdb6a92402bccf65ac42d2))

## [0.2.0](https://github.com/PixelHabits/mx/compare/v0.1.1...v0.2.0) (2026-10-19)


### Features

* **login:** copy the sign-in code and open the browser on Enter, as gh does ([10136e6](https://github.com/PixelHabits/mx/commit/10136e63b61bcac47de97141d4c01a1da22aa219))

## [0.1.1](https://github.com/PixelHabits/mx/compare/v0.1.0...v0.1.1) (2026-10-19)


### Bug Fixes

* **banner:** draw the sent and reply arrows one row lower ([aa16115](https://github.com/PixelHabits/mx/commit/aa1611551bac9adfb56031a310c795c1f3693a70))
* **banner:** put the reply arrow on the row under the sent one ([afc4cd3](https://github.com/PixelHabits/mx/commit/afc4cd3c95fdf83c54e301597bf1ed2f89e84bf7))
* **install:** find Claude Desktop's config in its Microsoft Store package on Windows ([9161957](https://github.com/PixelHabits/mx/commit/91619575a85eeef826e98aebb34d909fd0c1d971))
* **install:** say under the agent question what Space and Enter do ([e7181c3](https://github.com/PixelHabits/mx/commit/e7181c3730cfdc0c9b14362c54ed3927a8d56e01))
* **mcp:** speak the 2025-11-25 handshake too, because big sad, Anthropic's own Claude Desktop doesn't speak MCP 2026-07-28 yet ([4e4bd1e](https://github.com/PixelHabits/mx/commit/4e4bd1ea5fd35294094fdc721887674fa8256fea))
* **windows:** decide that mx sync stopped by whether its mxw.exe still runs ([c8be1e0](https://github.com/PixelHabits/mx/commit/c8be1e0908c8f3723e8faf5290f3eef332c74615))
* **windows:** install and wait for Enter when mx.exe is double-clicked ([5e58e55](https://github.com/PixelHabits/mx/commit/5e58e55390ded03221035009c2f7f179fa24b2e9))
* **windows:** reinstall and update while an agent runs a copy an earlier one moved aside ([353d41f](https://github.com/PixelHabits/mx/commit/353d41fca0fe8433ccb180b89162b59821dd414d))
* **windows:** set raw mode before readline reads, so one Enter closes the window ([4175aaa](https://github.com/PixelHabits/mx/commit/4175aaa6ad2cbc617c4d97421d0c72579c045227))

## [0.1.0](https://github.com/PixelHabits/mx/compare/v0.1.0...v0.1.0) (2026-10-18)


### Features

* **arch:** say what pacman leaves in home folders when mx is removed ([2d358bf](https://github.com/PixelHabits/mx/commit/2d358bf363f14ea18dbb0f1abbf2012b4fda2b64))
* build an Arch package from source, and let it own the binary and the sync unit ([407f6bf](https://github.com/PixelHabits/mx/commit/407f6bfef7740b8fb7d5e7de9881f431f3a6cff9))
* build for Linux and Windows, and set mx up with mx install ([008b0eb](https://github.com/PixelHabits/mx/commit/008b0eb16971a291b0cbd9a40f0fb6153fe4451b))
* **build:** build mx for macOS on Apple silicon and Intel, and check it on macOS ([7729473](https://github.com/PixelHabits/mx/commit/7729473be69636e17214eee5f43f631ba01bd6a7))
* **install:** ask which agents to set up and write their MCP configs directly ([e2bc19c](https://github.com/PixelHabits/mx/commit/e2bc19c8697e674f2b5a9df3999e796676884695))
* **install:** run mx sync as a launchd LaunchAgent on macOS ([3d64b63](https://github.com/PixelHabits/mx/commit/3d64b63682b7513128e9e6bbfcc13ce6798713ea))
* **install:** run the first sync in the foreground with progress, and sync folders in parallel ([34fa608](https://github.com/PixelHabits/mx/commit/34fa6083bfad0c9323c7d7186922e236dfadeb22))
* **install:** say how to put ~/.local/bin on PATH when the shell lacks it ([884fb0c](https://github.com/PixelHabits/mx/commit/884fb0c7ff693c38ab3f23eda351a78700c813b8))
* **mcp:** a query tool runs one read-only SELECT over views of the store ([28e0133](https://github.com/PixelHabits/mx/commit/28e01332cfd40210f5a40cfe17732757813a71e2))
* **mcp:** heal a stored message that Graph answers 404 for ([cd04787](https://github.com/PixelHabits/mx/commit/cd047873fc8b020d85271e43e4c5bf073b355f2f))
* **mcp:** point agents and the prompts at query for counting ([7051093](https://github.com/PixelHabits/mx/commit/7051093373360695c943cd9766826b65b921f31a))
* **mcp:** serve a triage prompt and an interview prompt ([a3edff1](https://github.com/PixelHabits/mx/commit/a3edff173dcd9a4c10bc823a51f74b3d4524877f))
* **mcp:** tell agents how to read the mailbox cheaply ([9a68377](https://github.com/PixelHabits/mx/commit/9a683772556f0a87022b72163496ed0957d2ea6f))
* **paths:** keep mx's files where macOS expects them ([3612276](https://github.com/PixelHabits/mx/commit/36122763ff9639411e3eeaf19b730142e737bfdd))
* play a banner when mx runs bare on a terminal ([7270f66](https://github.com/PixelHabits/mx/commit/7270f66ce80addd42837ad78aaa63d9f9119481e))
* **push:** download the pinned cloudflared on macOS ([6f15345](https://github.com/PixelHabits/mx/commit/6f153452733a4a70276dd4ccd89d3121787ce51f))
* **search:** rank by relevance, match word forms, and list each conversation once ([06596a4](https://github.com/PixelHabits/mx/commit/06596a4097ae9601d53424d8d15cfe9fae609b40))
* ship third-party notices with every binary ([0648eb6](https://github.com/PixelHabits/mx/commit/0648eb6d1ee35ad11ca865bbbeb5ecd667b0eb8c))
* **store:** version the store with numbered migrations, and refuse a store a newer mx wrote ([f850bd7](https://github.com/PixelHabits/mx/commit/f850bd70f7d3282f12073c8e2cbbed6ff972b97e))
* sync a Microsoft 365 mailbox through Graph and serve it to agents over MCP ([29033b0](https://github.com/PixelHabits/mx/commit/29033b02715976777dd5ab8215737ef9e620b2c0))
* **sync:** check the store against Graph after the first pass and daily ([4dda290](https://github.com/PixelHabits/mx/commit/4dda2905af225ed7b7837e51a08c94411b3ab466))
* **sync:** follow the mailbox through Graph push, with polling as the fallback ([0b42208](https://github.com/PixelHabits/mx/commit/0b422089c7bb76eb2ffafdfad963ae4382784a25))
* **sync:** record a heartbeat, report it in mx status, and warn in read tools ([d16f9ea](https://github.com/PixelHabits/mx/commit/d16f9eaa8be8a8672d028b55b0461e4c96669781))
* update mx from a signed release manifest ([5585d9b](https://github.com/PixelHabits/mx/commit/5585d9bd4c1a4601e04a69fc31fee0c7cdabb90a))


### Bug Fixes

* **install:** count the exit of a stopped mx sync as clean in its systemd unit ([765e0ab](https://github.com/PixelHabits/mx/commit/765e0ab58d4ff2c2127bede2baa8c97e50f23f0f))
* name the Arch packages in the uninstall and update messages ([4278eaf](https://github.com/PixelHabits/mx/commit/4278eaf1417c767b6a9d204cdc5e8cbe4ba8f9cc))
* **sync:** read partial delta entries, and skip a folder whose page mx cannot read ([c732a89](https://github.com/PixelHabits/mx/commit/c732a89b86c0b6c12fab6d2c23ee7a1a83423315))
* **sync:** skip a folder or a message Graph refuses, and keep mx sync running ([9e63123](https://github.com/PixelHabits/mx/commit/9e631233f7cd718dc150417b346fc6031d49860d))
