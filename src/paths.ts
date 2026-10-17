import { Config, Context, Effect, Layer, Option, Path } from "effect";

/** Where the Arch package installs mx; pacman owns the binary there and the sync unit beside it. */
const packagedBin = "/usr/bin/mx";

/** An XDG base directory, or its default below `$HOME` when the variable is unset or empty. */
const xdg = (name: string, home: string, fallback: string) =>
	Config.option(Config.NonEmptyString(name)).pipe(
		Config.map((dir) => Option.getOrElse(dir, () => `${home}/${fallback}`))
	);

/** Where mx keeps its config, its database, its saved sign-in and the attachments it downloads, and where `mx install` writes. */
export class Paths extends Context.Service<
	Paths,
	{
		/** `$XDG_CACHE_HOME/mx`, `~/Library/Caches/mx` on macOS, or `%LOCALAPPDATA%\mx\cache` on Windows, for downloaded attachments. */
		readonly cache: string;
		/** `config.json` in `$XDG_CONFIG_HOME/mx`, `~/Library/Application Support/mx` or `%LOCALAPPDATA%\mx`, with the client id `mx login` saved. */
		readonly configFile: string;
		/** `$XDG_DATA_HOME/mx`, `~/Library/Application Support/mx/data` or `%LOCALAPPDATA%\mx\data`, for the database and the cloudflared mx downloads. */
		readonly data: string;
		/** `mx.sqlite` in the data folder. */
		readonly database: string;
		/**
		 * `$XDG_STATE_HOME/mx`, `~/Library/Logs/mx` or `%LOCALAPPDATA%\mx\state`, for the sign-in file and the sync log. macOS
		 * always has a Keychain, so there it holds only the log.
		 */
		readonly state: string;
		/** The installed binary: `~/.local/bin/mx`, `/usr/bin/mx` from the Arch package, or `%LOCALAPPDATA%\Programs\mx\mx.exe`. */
		readonly bin: string;
		/** Whether mx runs from the Arch package, which owns the binary and the sync unit, so pacman installs and updates them. */
		readonly packaged: boolean;
		/** `$XDG_CONFIG_HOME`, `~/Library/Application Support` on macOS, or `%APPDATA%` on Windows, where other programs keep their settings. */
		readonly config: string;
		/** The user's home folder. */
		readonly home: string;
	}
>()("mx/paths") {
	/** The paths for this machine, read from its environment; for code that runs before any layer, as a command-line prompt. */
	static readonly make = Effect.gen(function* () {
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
				packaged: false,
				state: path.join(root, "state"),
			});
		}
		const home = yield* Config.NonEmptyString("HOME");
		if (process.platform === "darwin") {
			const library = path.join(home, "Library");
			const support = path.join(library, "Application Support");
			const root = path.join(support, "mx");
			return Paths.of({
				bin: path.join(home, ".local", "bin", "mx"),
				cache: path.join(library, "Caches", "mx"),
				config: support,
				configFile: path.join(root, "config.json"),
				data: path.join(root, "data"),
				database: path.join(root, "data", "mx.sqlite"),
				home,
				packaged: false,
				state: path.join(library, "Logs", "mx"),
			});
		}
		const { cache, config, data, state } = yield* Config.all({
			cache: xdg("XDG_CACHE_HOME", home, ".cache"),
			config: xdg("XDG_CONFIG_HOME", home, ".config"),
			data: xdg("XDG_DATA_HOME", home, ".local/share"),
			state: xdg("XDG_STATE_HOME", home, ".local/state"),
		});
		const packaged = path.resolve(process.execPath) === packagedBin;
		return Paths.of({
			bin: packaged ? packagedBin : path.join(home, ".local", "bin", "mx"),
			cache: path.join(cache, "mx"),
			config,
			configFile: path.join(config, "mx", "config.json"),
			data: path.join(data, "mx"),
			database: path.join(data, "mx", "mx.sqlite"),
			home,
			packaged,
			state: path.join(state, "mx"),
		});
	});

	static readonly layer = Layer.effect(Paths, Paths.make);
}
