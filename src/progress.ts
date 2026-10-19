import {
	Array as Arr,
	Clock,
	Console,
	Duration,
	Effect,
	Exit,
	Option,
	Ref,
	SynchronizedRef,
	Terminal,
} from "effect";
import { TerminalCapabilities } from "effect/cli";
import { type Pass, type Progress, summary } from "./sync.ts";

/** Without a terminal, a progress line at most this often. */
const lineInterval = Duration.seconds(30);

/** Erases the rest of the line, so a shorter line leaves nothing of a longer one. */
const clearLineEnd = "\u001b[K";

/** Moves the cursor up `lines` lines; nothing for none. */
const cursorUp = (lines: number) => (lines > 0 ? `\u001b[${lines}A` : "");

const minuteMillis = 60 * 1000;

const count = new Intl.NumberFormat("en");

/** About how long the rest takes at the rate so far, from at least one message read in `elapsedMillis`. */
const timeLeft = (
	{ fetched, total }: Progress,
	elapsedMillis: number
): string => {
	const left = (elapsedMillis * (total - fetched)) / fetched;
	return left < minuteMillis
		? "less than a minute left"
		: `about ${Math.ceil(left / minuteMillis)} min left`;
};

/** `Syncing 8 folders: 1,200 of 4,800 messages, about 6 min left`; the time left once a message has arrived. */
const progressLine = (progress: Progress, elapsedMillis: number) => {
	const fetched = Math.min(progress.fetched, progress.total);
	const line = `Syncing ${progress.folders} ${progress.folders === 1 ? "folder" : "folders"}: ${count.format(fetched)} of ${count.format(progress.total)} messages`;
	return fetched === 0
		? line
		: `${line}, ${timeLeft({ ...progress, fetched }, elapsedMillis)}`;
};

/** One pass to show, and what its lines start with. */
export interface Shown<E> {
	readonly about: (text: string) => string;
	readonly pass: (
		report: (progress: Progress) => Effect.Effect<void>
	) => Effect.Effect<Pass, E>;
}

const show =
	(terminal: Terminal.Terminal) =>
	<E>(passes: readonly Shown<E>[]) =>
		Effect.gen(function* () {
			const { canAnimate: onTerminal } =
				yield* TerminalCapabilities.TerminalCapabilities;
			/** On a terminal, each pass's line, in the order of the passes; none before the pass writes one. */
			const drawn = yield* SynchronizedRef.make(
				Arr.map(passes, () => Option.none<string>())
			);
			/**
			 * On a terminal, sets the pass's line and draws every line over the ones drawn before, from the first; elsewhere,
			 * prints it.
			 */
			const write = (index: number, text: string) =>
				onTerminal
					? SynchronizedRef.updateEffect(drawn, (before) => {
							const after = Arr.map(before, (line, each) =>
								each === index ? Option.some(text) : line
							);
							const lines = Arr.join(
								Arr.map(
									Arr.getSomes(after),
									(line) => `\r${line}${clearLineEnd}`
								),
								"\n"
							);
							return Effect.as(
								Effect.orDie(
									terminal.display(
										`${cursorUp(Arr.getSomes(before).length - 1)}${lines}`
									)
								),
								after
							);
						})
					: Console.log(text);
			/** On a terminal, ends the last line once any was drawn, so what comes next starts on a line of its own. */
			const endLine = Effect.flatMap(SynchronizedRef.get(drawn), (lines) =>
				Arr.some(lines, Option.isSome)
					? Effect.orDie(terminal.display("\n"))
					: Effect.void
			);

			const run = Effect.fnUntraced(function* (
				{ about, pass }: Shown<E>,
				index: number
			) {
				/** When the first report came and when a line was last written; none before the first report. */
				const shown = yield* Ref.make(
					Option.none<{ readonly since: number; readonly written: number }>()
				);

				const report = Effect.fnUntraced(function* (progress: Progress) {
					const now = yield* Clock.currentTimeMillis;
					const previous = yield* Ref.get(shown);
					const due =
						onTerminal ||
						Option.match(previous, {
							onNone: () => true,
							onSome: ({ written }) =>
								now - written >= Duration.toMillis(lineInterval),
						});
					if (!due) {
						return;
					}
					const since = Option.match(previous, {
						onNone: () => now,
						onSome: (first) => first.since,
					});
					yield* write(index, about(progressLine(progress, now - since)));
					yield* Ref.set(shown, Option.some({ since, written: now }));
				});

				const finish = Effect.fnUntraced(function* (exit: Exit.Exit<Pass, E>) {
					if (Option.isSome(yield* Ref.get(shown)) && Exit.isSuccess(exit)) {
						yield* write(index, about(summary(exit.value)));
					}
				});

				yield* pass(report).pipe(Effect.onExit(finish));
			});

			yield* Effect.forEach(passes, run, {
				concurrency: "unbounded",
				discard: true,
			}).pipe(Effect.ensuring(endLine));
		});

/**
 * A function that runs every pass at once and shows how far each has got, on a line of its own that starts as its
 * `about` says. On a terminal that can redraw in place every line is redrawn at each report; elsewhere a pass prints a
 * line at its first report and then at most every 30 seconds. Once a pass showed anything, its summary ends its line.
 */
export const showProgress = Effect.map(Terminal.Terminal, show);
