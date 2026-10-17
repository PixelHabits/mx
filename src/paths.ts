import { Config, Context, Effect, Layer, Option, Path } from "effect";

/** An XDG base directory, or its default below `$HOME` when the variable is unset or empty. */
const xdg = (name: string, fallback: string) =>
	Config.all({
		dir: Config.option(Config.NonEmptyString(name)),
		home: Config.NonEmptyString("HOME"),
	}).pipe(
		Config.map(({ dir, home }) =>
			Option.getOrElse(dir, () => `${home}/${fallback}`)
		)
	);

/** Where mx keeps its config, its database, its saved sign-in and the attachments it downloads. */
export class Paths extends Context.Service<
	Paths,
	{
		/** `$XDG_CACHE_HOME/mx`, for downloaded attachments. */
		readonly cache: string;
		/** `$XDG_CONFIG_HOME/mx/config.json`, with the client id `mx login` saved. */
		readonly configFile: string;
		/** `$XDG_DATA_HOME/mx/mx.sqlite`. */
		readonly database: string;
		/** `$XDG_STATE_HOME/mx`, for the sign-in file on a machine without a secret store. */
		readonly state: string;
	}
>()("mx/paths") {
	static readonly layer = Layer.effect(
		Paths,
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const { cache, config, data, state } = yield* Config.all({
				cache: xdg("XDG_CACHE_HOME", ".cache"),
				config: xdg("XDG_CONFIG_HOME", ".config"),
				data: xdg("XDG_DATA_HOME", ".local/share"),
				state: xdg("XDG_STATE_HOME", ".local/state"),
			});
			return Paths.of({
				cache: path.join(cache, "mx"),
				configFile: path.join(config, "mx", "config.json"),
				database: path.join(data, "mx", "mx.sqlite"),
				state: path.join(state, "mx"),
			});
		})
	);
}
