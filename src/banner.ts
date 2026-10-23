import {
	Array as Arr,
	Config,
	Duration,
	Effect,
	Option,
	pipe,
	String as Str,
	Terminal,
} from "effect";

/** The pause between frames: 15 frames play in about a second. */
const frameDelay = Duration.millis(60);

/** The cells between the mailbox and the inbox, where the envelopes travel. */
const laneWidth = 26;

/** Where each lane's envelope rests in the last frame: the sent one at the start, the reply at the end. */
const sentAt = 6;
const replyAt = 19;

/** The cells an envelope passes through on its way out and on its way back. */
const outward = Arr.makeBy(7, (step) => sentAt + 3 * step);
const back = Arr.makeBy(7, (step) => replyAt - 3 * step);

const hideCursor = "\u001b[?25l";
const showCursor = "\u001b[?25h";
const up = (lines: number) => `\u001b[${lines}A\r`;

/** Windows conhost's fonts lack the dingbat envelope and the box diagonals, so Windows draws code page 437 glyphs. */
const glyphsFor = (windows: boolean) =>
	windows
		? { envelope: "≡", fall: "\\", rise: "/", tray: "≡" }
		: { envelope: "✉", fall: "╲", rise: "╱", tray: "▤" };

/**
 * The frames of the banner: an envelope goes from the mailbox to the inbox, a reply comes back, and the last frame shows
 * both arrows.
 */
const frames = ({
	color,
	windows,
}: {
	readonly color: boolean;
	readonly windows: boolean;
}) => {
	const glyphs = glyphsFor(windows);
	const envelope = color
		? `\u001b[36m${glyphs.envelope}\u001b[39m`
		: glyphs.envelope;
	const sent = `${pipe(" ", Str.repeat(sentAt))}@ ─ ─ ─ ─ ─ ─►${pipe(" ", Str.repeat(6))}`;
	const reply = `${pipe(" ", Str.repeat(sentAt))}◄─ ─ ─ ─ ─ ─ @${pipe(" ", Str.repeat(6))}`;
	/** `lane` with the envelope at `at` and only the cells `keep` names. */
	const draw = (lane: string, at: number, keep: (cell: number) => boolean) =>
		Arr.join(
			Arr.map(Array.from(lane), (glyph, cell) => {
				if (cell === at) {
					return envelope;
				}
				return keep(cell) && glyph !== "@" ? glyph : " ";
			}),
			""
		);
	const frame = (top: string, bottom: string) =>
		Arr.join(
			[
				`  ┌───────┐${pipe(" ", Str.repeat(laneWidth))}┌───────┐`,
				`  │${glyphs.fall}     ${glyphs.rise}│${top}│  ${pipe(glyphs.tray, Str.repeat(3))}  │`,
				`  │  ${glyphs.fall} ${glyphs.rise}  │${bottom}│ inbox │`,
				`  └───────┘${pipe(" ", Str.repeat(laneWidth))}└───────┘`,
				`${pipe(" ", Str.repeat(22))}${color ? "\u001b[1mmx\u001b[22m" : "mx"}`,
			],
			"\n"
		);
	const sentArrow = draw(sent, sentAt, () => true);
	return [
		...Arr.map(outward, (at) =>
			frame(
				draw(sent, at, (cell) => cell > sentAt && cell < at),
				pipe(" ", Str.repeat(laneWidth))
			)
		),
		...Arr.map(back, (at) =>
			frame(
				sentArrow,
				draw(reply, at, (cell) => cell > at && cell < replyAt)
			)
		),
		frame(
			sentArrow,
			draw(reply, replyAt, () => true)
		),
	];
};

/** The lines a frame takes on the terminal. */
const height = 5;

/**
 * Plays the banner on a terminal: each frame redraws the last one in place, the last frame stays, and the cursor shows
 * again however the banner ends. `NO_COLOR` turns the colors off.
 */
export const banner = Effect.gen(function* () {
	const terminal = yield* Terminal.Terminal;
	const noColor = yield* Config.option(Config.NonEmptyString("NO_COLOR"));
	const [first, ...rest] = frames({
		color: Option.isNone(noColor),
		windows: process.platform === "win32",
	});
	yield* Effect.acquireUseRelease(
		terminal.display(`${hideCursor}${first}\n`),
		() =>
			Effect.forEach(
				rest,
				(next) =>
					Effect.andThen(
						Effect.sleep(frameDelay),
						terminal.display(`${up(height)}${next}\n`)
					),
				{ discard: true }
			),
		() => Effect.ignore(terminal.display(showCursor))
	);
}).pipe(Effect.orDie);
