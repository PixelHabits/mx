/**
 * What `Bun.secrets` meets on the machine: a secret store, no secret store, a store that fails, or the macOS login
 * Keychain, which deletes an item only for a program with the file name of the one that saved it, and only while the
 * deleting program's file is on disk.
 */
type Machine = "store" | "none" | "broken" | "keychain";

/** What Bun says: `none` on a Linux desktop without a Secret Service under dbus-broker, `broken` when D-Bus is down. */
const failures: Record<Exclude<Machine, "store" | "keychain">, string> = {
	broken: "Could not connect: Connection refused (code: 39)",
	none: "The name is not activatable (code: 2)",
};

/** What Bun says when the Keychain refuses a delete with errSecInvalidOwnerEdit. */
const notOwner =
	"Invalid attempt to change the owner of this item. (code: -25244)";

/** The file name at the end of a path, which the Keychain compares programs by. */
const lastName = /[^/\\]*$/u;
const fileName = (file: string) => lastName.exec(file)?.[0] ?? "";

const platformError = (message: string) =>
	Object.assign(new Error(message), { code: "ERR_SECRETS_PLATFORM_ERROR" });

/**
 * `Bun.secrets` in memory, installed over the real one so no test reaches the system's keyring. `machine` decides what
 * each call meets; on a failure it throws what Bun throws, an Error with code `ERR_SECRETS_PLATFORM_ERROR`.
 */
export class FakeSecrets {
	machine: Machine = "store";
	readonly entries = new Map<string, string>();
	/** The program that saved each entry: `process.execPath` when the entry was set first. */
	private readonly savedBy = new Map<string, string>();

	readonly api = {
		delete: ({ name, service }: { name: string; service: string }) =>
			this.call(async () => {
				const key = `${service}/${name}`;
				if (
					this.machine === "keychain" &&
					this.entries.has(key) &&
					!(await this.savedByCaller(key))
				) {
					throw platformError(notOwner);
				}
				return this.entries.delete(key);
			}),
		get: ({ name, service }: { name: string; service: string }) =>
			this.call(() => this.entries.get(`${service}/${name}`) ?? null),
		set: ({
			name,
			service,
			value,
		}: {
			name: string;
			service: string;
			value: string;
		}) =>
			this.call(() => {
				const key = `${service}/${name}`;
				if (!this.entries.has(key)) {
					this.savedBy.set(key, process.execPath);
				}
				this.entries.set(key, value);
			}),
	} satisfies typeof Bun.secrets;

	install() {
		Reflect.set(Bun, "secrets", this.api);
	}

	/** Whether the program that runs has the file name of the one that saved `key`, and its file is on disk. */
	private async savedByCaller(key: string) {
		return (
			fileName(this.savedBy.get(key) ?? "") === fileName(process.execPath) &&
			(await Bun.file(process.execPath).exists())
		);
	}

	private call<A>(run: () => A | Promise<A>): Promise<A> {
		if (this.machine === "store" || this.machine === "keychain") {
			return Promise.resolve(run());
		}
		return Promise.reject(platformError(failures[this.machine]));
	}
}
