import { Config, Context, Effect, Layer, Option, Path } from "effect";
import { UserDirectories } from "effect/persistence";

/** Where the Arch packages install mx; pacman owns the binary there and the sync unit beside it. */
export const packagedBin = "/usr/bin/mx";

/** The name of mx's own folders. */
const app = "mx";

/**
 * Where mx keeps its config, its database, its saved sign-in and the attachments it downloads, and where `mx install`
 * writes. Its own folders are where Effect's `UserDirectories` puts them: an absolute XDG variable wins on every system,
 * and otherwise each system's own folder holds them.
 */
export class Paths extends Context.Service<
	Paths,
	{
		/** `$XDG_CACHE_HOME/mx`, `~/Library/Caches/mx` on macOS, or `%LOCALAPPDATA%\mx\Cache` on Windows, for downloaded attachments. */
		readonly cache: string;
		/** `config.json` in `$XDG_CONFIG_HOME/mx`, `~/Library/Application Support/mx` or `%APPDATA%\mx`, with the client id `mx login` saved. */
		readonly configFile: string;
		/** `$XDG_DATA_HOME/mx`, `~/Library/Application Support/mx` or `%APPDATA%\mx`, for the database and the cloudflared mx downloads. */
		readonly data: string;
		/** `mx.sqlite` in the data folder. */
		readonly database: string;
		/**
		 * `$XDG_STATE_HOME/mx`, `~/Library/Application Support/mx` or `%LOCALAPPDATA%\mx`, for the sign-in file and the
		 * logs. macOS always has a Keychain, so there it holds only the logs.
		 */
		readonly state: string;
		/** `log.sqlite` in the state folder: every tool call, prompt and mx sync line. */
		readonly log: string;
		/** The installed binary: `~/.local/bin/mx`, `/usr/bin/mx` from an Arch package, or `%LOCALAPPDATA%\Programs\mx\mx.exe`. */
		readonly bin: string;
		/** Whether mx runs from an Arch package, which owns the binary and the sync unit, so pacman installs and updates them. */
		readonly packaged: boolean;
		/** `$XDG_CONFIG_HOME`, `~/Library/Application Support` on macOS, or `%APPDATA%` on Windows, where other programs keep their settings. */
		readonly config: string;
		/** `%LOCALAPPDATA%\Packages` on Windows, with a folder of files for each packaged app, as one from the Microsoft Store; none elsewhere. */
		readonly appPackages: Option.Option<string>;
		/** The user's home folder. */
		readonly home: string;
	}
>()("mx/paths") {
	/** The paths for this machine, read from its environment; for code that runs before any layer, as a command-line prompt. */
	static readonly make = Effect.gen(function* () {
		const path = yield* Path.Path;
		const directories = UserDirectories.make();
		const { cache, config, data, home, state } = yield* Effect.all({
			cache: directories.cache(app),
			config: directories.config(app),
			data: directories.data(app),
			home: directories.home,
			state: directories.state(app),
		});
		const own = {
			cache,
			configFile: path.join(config, "config.json"),
			data,
			database: path.join(data, "mx.sqlite"),
			home,
			log: path.join(state, "log.sqlite"),
			state,
		};
		if (process.platform === "win32") {
			const { appData, localAppData } = yield* Config.all({
				appData: Config.NonEmptyString("APPDATA"),
				localAppData: Config.NonEmptyString("LOCALAPPDATA"),
			});
			return Paths.of({
				...own,
				appPackages: Option.some(path.join(localAppData, "Packages")),
				bin: path.join(localAppData, "Programs", "mx", "mx.exe"),
				config: appData,
				packaged: false,
			});
		}
		if (process.platform === "darwin") {
			return Paths.of({
				...own,
				appPackages: Option.none(),
				bin: path.join(home, ".local", "bin", "mx"),
				config: path.join(home, "Library", "Application Support"),
				packaged: false,
			});
		}
		const shared = yield* Config.option(
			Config.NonEmptyString("XDG_CONFIG_HOME")
		);
		const packaged = path.resolve(process.execPath) === packagedBin;
		return Paths.of({
			...own,
			appPackages: Option.none(),
			bin: packaged ? packagedBin : path.join(home, ".local", "bin", "mx"),
			config: Option.getOrElse(shared, () => path.join(home, ".config")),
			packaged,
		});
	});

	static readonly layer = Layer.effect(Paths, Paths.make);
}
