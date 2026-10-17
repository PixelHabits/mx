import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";

/** ISO calendar date text such as `2026-10-14`; an impossible date such as 2026-02-30 is invalid, not clamped. */
export const PlainDateFromString = Schema.String.pipe(
	Schema.decodeTo(Schema.instanceOf(Temporal.PlainDate), {
		decode: SchemaGetter.transformEffect((text) =>
			Effect.try({
				catch: () =>
					new SchemaIssue.InvalidValue(
						{ message: "Invalid calendar date" },
						text
					),
				try: () => Temporal.PlainDate.from(text, { overflow: "reject" }),
			})
		),
		encode: SchemaGetter.transform((value) => value.toString()),
	})
);

/** ISO instant text with its offset, decoded into a `Temporal.Instant`. */
export const InstantFromString = Schema.String.pipe(
	Schema.decodeTo(Schema.instanceOf(Temporal.Instant), {
		decode: SchemaGetter.transformEffect((text) =>
			Effect.try({
				catch: () =>
					new SchemaIssue.InvalidValue({ message: "Invalid instant" }, text),
				try: () => Temporal.Instant.from(text),
			})
		),
		encode: SchemaGetter.transform((value) => value.toString()),
	})
);

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** `2026-10-14 09:12` in the machine's time zone. */
export const localTime = (instant: Temporal.Instant) => {
	const local = instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
	return `${local.toPlainDate().toString()} ${twoDigits(local.hour)}:${twoDigits(local.minute)}`;
};
