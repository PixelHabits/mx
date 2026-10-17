/** What `Bun.secrets` meets on the machine: a secret store, no secret store, or a store that fails. */
type Machine = "store" | "none" | "broken";

/** What Bun says: `none` on a Linux desktop without a Secret Service under dbus-broker, `broken` when D-Bus is down. */
const failures: Record<Exclude<Machine, "store">, string> = {
	broken: "Could not connect: Connection refused (code: 39)",
	none: "The name is not activatable (code: 2)",
};

/**
 * `Bun.secrets` in memory, installed over the real one so no test reaches the system's keyring. `machine` decides what
 * each call meets; on a failure it throws what Bun throws, an Error with code `ERR_SECRETS_PLATFORM_ERROR`.
 */
export class FakeSecrets {
	machine: Machine = "store";
	readonly entries = new Map<string, string>();

	readonly api = {
		delete: ({ name, service }: { name: string; service: string }) =>
			this.call(() => this.entries.delete(`${service}/${name}`)),
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
				this.entries.set(`${service}/${name}`, value);
			}),
	} satisfies typeof Bun.secrets;

	install() {
		Reflect.set(Bun, "secrets", this.api);
	}

	private call<A>(run: () => A): Promise<A> {
		if (this.machine === "store") {
			return Promise.resolve(run());
		}
		return Promise.reject(
			Object.assign(new Error(failures[this.machine]), {
				code: "ERR_SECRETS_PLATFORM_ERROR",
			})
		);
	}
}
