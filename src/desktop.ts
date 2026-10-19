import { Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { onSystem } from "./system.ts";

/** A program and its arguments. */
type Program = readonly [command: string, ...args: string[]];

/**
 * Whether `program` runs and exits 0, with `input` on its stdin; a missing program answers no. It stays in mx's process
 * group, because Effect ends the group of a detached program once it exits, and with it the copy that wl-copy and xclip
 * leave to hold the clipboard, or the browser xdg-open starts. Its output goes nowhere, so that copy holds no pipe open.
 */
const works = (
	spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
	[command, ...args]: Program,
	input: ChildProcess.CommandInput = "ignore"
) =>
	spawner
		.exitCode(
			ChildProcess.make(command, args, {
				detached: false,
				stderr: "ignore",
				stdin: input,
				stdout: "ignore",
			})
		)
		.pipe(
			Effect.map((code) => code === 0),
			Effect.orElseSucceed(() => false)
		);

/** How long a clipboard program may run; wl-copy can wait forever for keyboard focus on some Wayland compositors. */
const clipboardTimeLimit = Duration.seconds(2);

/**
 * Copies `text` to the clipboard with the first program that works on this system, and answers whether one did. A
 * program that runs past `clipboardTimeLimit` has not worked; Effect kills it, and the next one runs.
 */
export const copyToClipboard = (
	spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
	text: string
) =>
	Effect.findFirst(
		onSystem<readonly Program[]>({
			darwin: [["pbcopy"]],
			linux: [
				["wl-copy"],
				["xclip", "-selection", "clipboard"],
				["xsel", "--clipboard", "--input"],
			],
			win32: [["clip.exe"]],
		}),
		(program) =>
			works(
				spawner,
				program,
				Stream.succeed(new TextEncoder().encode(text))
			).pipe(
				Effect.timeoutOrElse({
					duration: clipboardTimeLimit,
					orElse: () => Effect.succeed(false),
				})
			)
	).pipe(Effect.map(Option.isSome));

/** Opens `url` in the default browser, and answers whether that worked. */
export const openInBrowser = (
	spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
	url: string
) =>
	works(
		spawner,
		onSystem<Program>({
			darwin: ["open", url],
			linux: ["xdg-open", url],
			// cmd's start would parse the URL again, and split it at each &.
			win32: ["rundll32.exe", "url.dll,FileProtocolHandler", url],
		})
	);
