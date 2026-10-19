import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect";
import { CredentialFailed, LoginRequired } from "../errors.ts";
import { Paths } from "../paths.ts";
import { ClientId, Tenant } from "./config.ts";

/**
 * The name of an account's sign-in: its entry in the secret store, Windows Credential Manager, the macOS Keychain or
 * libsecret, and its plain-text file on a machine without one. Account 1's is `refresh-token`, the name an mx mcp of an
 * earlier release, which an update leaves running, reads.
 */
const nameOf = (account: number) =>
	account === 1 ? "refresh-token" : `refresh-token-${account}`;

const service = "mx";

/**
 * A saved sign-in: the refresh token, the client id and the tenant Microsoft issued it for, and the id `mx login` gave
 * it. A refresh keeps the id, and each `mx login` makes a new one, so a process can tell a new sign-in from a rotated
 * token.
 */
const SavedSignIn = Schema.fromJsonString(
	Schema.Struct({
		clientId: ClientId,
		id: Schema.String,
		refreshToken: Schema.RedactedFromValue(Schema.String),
		tenant: Tenant,
	})
);
export type SignIn = typeof SavedSignIn.Type;
const decodeSignIn = Schema.decodeEffect(SavedSignIn);
const encodeSignIn = Schema.encodeEffect(SavedSignIn);

const SecretsError = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
});

/**
 * D-Bus answers ServiceUnknown when no Secret Service is installed: dbus-broker says "The name is not activatable" and
 * dbus-daemon says the name "was not provided by any .service files". Bun reports either as ERR_SECRETS_PLATFORM_ERROR,
 * which also covers every other libsecret failure.
 */
const noSecretService =
	/The name is not activatable|was not provided by any \.service files/u;

const isNoSecretStore = (error: unknown) =>
	Schema.is(SecretsError)(error) &&
	error.code === "ERR_SECRETS_PLATFORM_ERROR" &&
	noSecretService.test(error.message);

/** Runs a `Bun.secrets` call; none says the machine has no secret store, and any other failure fails loudly. */
const inSecretStore = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		catch: (error) =>
			CredentialFailed.make({
				message: `The secret store failed: ${error instanceof Error ? error.message : String(error)}`,
			}),
		try: () =>
			run().then(Option.some, (error: unknown) =>
				isNoSecretStore(error) ? Option.none<A>() : Promise.reject(error)
			),
	});

/**
 * Each account's sign-in, in the system's secret store through `Bun.secrets`, or in a file only the user can read when
 * the machine has no secret store. Each process reads a sign-in and writes its rotated token back; the last write wins.
 * Each file is written by renaming a complete file over the old one, so a reader never sees half of one.
 */
export class Credentials extends Context.Service<
	Credentials,
	{
		readonly read: (
			account: number
		) => Effect.Effect<SignIn, LoginRequired | CredentialFailed>;
		readonly write: (
			account: number,
			signIn: SignIn
		) => Effect.Effect<void, CredentialFailed>;
		/** Deletes the account's saved sign-in. */
		readonly remove: (account: number) => Effect.Effect<void, CredentialFailed>;
	}
>()("mx/auth/credentials") {
	static readonly layer = Layer.effect(
		Credentials,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { state } = yield* Paths;
			const fileOf = (account: number) => path.join(state, nameOf(account));
			const entryOf = (account: number) => ({ name: nameOf(account), service });
			const failed = (error: { readonly message: string }) =>
				CredentialFailed.make({ message: error.message });

			const readFile = Effect.fnUntraced(function* (file: string) {
				if (!(yield* fs.exists(file))) {
					return Option.none<string>();
				}
				return Option.some(yield* fs.readFileString(file));
			});

			const read = Effect.fn("Credentials.read")(
				function* (account: number) {
					const stored = yield* inSecretStore(() =>
						Bun.secrets.get(entryOf(account))
					);
					const saved = Option.isSome(stored)
						? Option.fromNullishOr(stored.value)
						: yield* readFile(fileOf(account));
					if (Option.isNone(saved)) {
						return yield* LoginRequired.make({ reason: "No saved sign-in." });
					}
					// The decoding error quotes what it read, and that holds the refresh token.
					return yield* decodeSignIn(saved.value).pipe(
						Effect.mapError(() =>
							CredentialFailed.make({
								message:
									"The saved sign-in is not one mx can read. Run mx login.",
							})
						)
					);
				},
				Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error)))
			);

			const write = Effect.fn("Credentials.write")(
				function* (account: number, signIn: SignIn) {
					const value = yield* encodeSignIn(signIn).pipe(Effect.orDie);
					const stored = yield* inSecretStore(() =>
						Bun.secrets.set({ ...entryOf(account), value })
					);
					if (Option.isSome(stored)) {
						return;
					}
					yield* fs.makeDirectory(state, { mode: 0o700, recursive: true });
					const staged = yield* fs.makeTempFileScoped({ directory: state });
					yield* fs.chmod(staged, 0o600);
					yield* fs.writeFileString(staged, value);
					yield* fs.rename(staged, fileOf(account));
				},
				Effect.scoped,
				Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error)))
			);

			const remove = Effect.fn("Credentials.remove")(
				function* (account: number) {
					yield* inSecretStore(() => Bun.secrets.delete(entryOf(account)));
					yield* fs.remove(fileOf(account), { force: true });
				},
				Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error)))
			);

			return Credentials.of({ read, remove, write });
		})
	);
}
