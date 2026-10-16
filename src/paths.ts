import { Config, Context, Effect, Layer, Option, Path } from "effect";

/** An XDG base directory, or its default below `$HOME` when the variable is unset or empty. */
const xdg = (name: string, home: string, fallback: string) =>
	Config.option(Config.NonEmptyString(name)).pipe(
		Config.map((dir) => Option.getOrElse(dir, () => `${home}/${fallback}`))
	);

/** Where mx keeps its config, its database, its saved sign-in and the attachments it downloads, and where `mx install` writes. */
export class Paths extends Context.Service<
	Paths,
	{
		/** `$XDG_CACHE_HOME/mx`, or `%LOCALAPPDATA%\mx\cache` on Windows, for downloaded attachments. */
		readonly cache: string;
		/** `$XDG_CONFIG_HOME/mx/config.json`, or `%LOCALAPPDATA%\mx\config.json`, with the client id `mx login` saved. */
		readonly configFile: string;
		/** `$XDG_DATA_HOME/mx`, or `%LOCALAPPDATA%\mx\data`, for the database and the cloudflared mx downloads. */
		readonly data: string;
		/** `mx.sqlite` in the data folder. */
		readonly database: string;
		/** `$XDG_STATE_HOME/mx`, or `%LOCALAPPDATA%\mx\state`, for the sign-in file and the sync log. */
		readonly state: string;
		/** The installed binary: `~/.local/bin/mx`, or `%LOCALAPPDATA%\Programs\mx\mx.exe`. */
		readonly bin: string;
		/** `$XDG_CONFIG_HOME`, or `%APPDATA%` on Windows, where other programs keep their settings. */
		readonly config: string;
		/** The user's home folder. */
		readonly home: string;
	}
>()("mx/paths") {
	static readonly layer = Layer.effect(
		Paths,
		Effect.gen(function* () {
			const path = yield* Path.Path;
			if (process.platform === "win32") {
				const { appData, home, localAppData } = yield* Config.all({
					appData: Config.NonEmptyString("APPDATA"),
					home: Config.NonEmptyString("USERPROFILE"),
					localAppData: Config.NonEmptyString("LOCALAPPDATA"),
				});
				const root = path.join(localAppData, "mx");
				return Paths.of({
					bin: path.join(localAppData, "Programs", "mx", "mx.exe"),
					cache: path.join(root, "cache"),
					config: appData,
					configFile: path.join(root, "config.json"),
					data: path.join(root, "data"),
					database: path.join(root, "data", "mx.sqlite"),
					home,
					state: path.join(root, "state"),
				});
			}
			const home = yield* Config.NonEmptyString("HOME");
			const { cache, config, data, state } = yield* Config.all({
				cache: xdg("XDG_CACHE_HOME", home, ".cache"),
				config: xdg("XDG_CONFIG_HOME", home, ".config"),
				data: xdg("XDG_DATA_HOME", home, ".local/share"),
				state: xdg("XDG_STATE_HOME", home, ".local/state"),
			});
			return Paths.of({
				bin: path.join(home, ".local", "bin", "mx"),
				cache: path.join(cache, "mx"),
				config,
				configFile: path.join(config, "mx", "config.json"),
				data: path.join(data, "mx"),
				database: path.join(data, "mx", "mx.sqlite"),
				home,
				state: path.join(state, "mx"),
			});
		})
	);
}
