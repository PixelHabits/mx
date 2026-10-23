import {
	Clock,
	Console,
	Duration,
	Effect,
	Exit,
	Option,
	Ref,
	Terminal,
} from "effect";
import { TerminalCapabilities } from "effect/cli";
import { type Pass, type Progress, summary } from "./sync.ts";

/** Without a terminal, a progress line at most this often. */
const lineInterval = Duration.seconds(30);

/** Erases the rest of the line, so a shorter line leaves nothing of a longer one. */
const clearLineEnd = "\u001b[K";

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

const show =
	(terminal: Terminal.Terminal) =>
	<E>(
		pass: (
			report: (progress: Progress) => Effect.Effect<void>
		) => Effect.Effect<Pass, E>
	) =>
		Effect.gen(function* () {
			const { canAnimate: onTerminal } =
				yield* TerminalCapabilities.TerminalCapabilities;
			/** On a terminal, draws the line over the last one; elsewhere, prints it. */
			const write = (text: string) =>
				onTerminal
					? Effect.orDie(terminal.display(`\r${text}${clearLineEnd}`))
					: Console.log(text);
			/** On a terminal, ends the line, so what comes next starts on a line of its own. */
			const endLine = onTerminal
				? Effect.orDie(terminal.display("\n"))
				: Effect.void;
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
				yield* write(progressLine(progress, now - since));
				yield* Ref.set(shown, Option.some({ since, written: now }));
			});

			const finish = Effect.fnUntraced(function* (exit: Exit.Exit<Pass, E>) {
				if (Option.isNone(yield* Ref.get(shown))) {
					return;
				}
				if (Exit.isSuccess(exit)) {
					yield* write(summary(exit.value));
				}
				yield* endLine;
			});

			return yield* pass(report).pipe(Effect.onExit(finish));
		});

/**
 * A function that runs `pass` and shows how far it has got. On a terminal that can redraw in place one line is redrawn
 * at each report; elsewhere a line is printed at the first report and then at most every 30 seconds. Once anything was
 * shown, the pass's summary ends it.
 */
export const showProgress = Effect.map(Terminal.Terminal, show);
