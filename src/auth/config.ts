import {
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	pipe,
	Schema,
	String as Str,
	type Terminal,
} from "effect";
import { CliError, Flag, Prompt, TerminalCapabilities } from "effect/cli";
import { CredentialFailed } from "../errors.ts";
import { Paths } from "../paths.ts";

/** An Entra application or tenant id: a GUID. */
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A domain name of two or more labels, such as contoso.com. */
const domain =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu;

/** The client id mx signs in with. */
export const ClientId = Schema.String.check(Schema.isPattern(guid));

/** The tenant that serves any work or school account, and the one `mx login` offers first. */
export const organizations = "organizations";

/** The tenant mx signs in at: `organizations`, a tenant id, or a domain verified in the tenant. */
export const Tenant = Schema.Union([
	Schema.Literal(organizations),
	Schema.String.check(Schema.isPattern(guid)),
	Schema.String.check(Schema.isPattern(domain)),
]);

/** What mx signs in with. */
export interface SignInConfig {
	readonly clientId: string;
	readonly tenant: string;
}

const aliasPattern = /^[a-z][a-z0-9-]{0,19}$/u;

/** What mx says when an alias breaks the rules. */
export const aliasRule =
	"An alias is up to 20 lowercase letters, digits and hyphens, and starts with a letter, such as work.";

/** The name an account shows as and that commands take, unique among the accounts. */
export const Alias = Schema.String.check(Schema.isPattern(aliasPattern));

/** Who signed in to an account, as the id token of the sign-in names them: the address, the tenant and the user. */
export const Identity = Schema.Struct({
	address: Schema.optionalKey(Schema.String),
	oid: Schema.String,
	tid: Schema.String,
});
export type Identity = typeof Identity.Type;

/**
 * An account: its id, under which the store files its folders with their mail and the secret store keeps its sign-in,
 * the alias it shows as, what it signs in with, and who signed in to it, once mx knows.
 */
export const Account = Schema.Struct({
	address: Schema.optionalKey(Schema.String),
	alias: Alias,
	clientId: ClientId,
	id: Schema.Int,
	oid: Schema.optionalKey(Schema.String),
	tenant: Tenant,
	tid: Schema.optionalKey(Schema.String),
});
export type Account = typeof Account.Type;

/** The account a layer serves. */
export class AccountId extends Context.Service<AccountId, number>()(
	"mx/auth/config/AccountId"
) {
	/** Account 1, the one mx sync and the tools serve. */
	static readonly first = Layer.succeed(AccountId, 1);
}

/** The alias of an account whose tenant names none, as `organizations` or a tenant id. */
export const fallbackAlias = "main";

/** The alias mx offers for an account at `tenant`: the first label of its domain, as contoso for contoso.com, or else main. */
export const defaultAlias = (tenant: string) => {
	const [label = "", ...rest] = pipe(tenant, Str.toLowerCase, Str.split("."));
	return rest.length > 0 && aliasPattern.test(label) ? label : fallbackAlias;
};

/** A list in prose, such as "work, personal and travel". */
export const listed = new Intl.ListFormat("en", { type: "conjunction" });

/** config.json as mx 0.3.0 and earlier write it: the client id and the tenant of the one account. */
const OneAccount = Schema.Struct({ clientId: ClientId, tenant: Tenant });

/** config.json: the accounts, oldest first. */
const Accounts = Schema.Struct({ accounts: Schema.Array(Account) });

const decodeConfig = Schema.decodeEffect(
	Schema.fromJsonString(Schema.Union([Accounts, OneAccount]))
);
const encodeConfig = Schema.encodeEffect(
	Schema.fromJsonString(Accounts, { space: 2 })
);

/**
 * config.json, which names the accounts. Every process reads the one account of an older config.json as account 1 with
 * the alias of its tenant, so processes that read it at once agree. Each write renames a complete file over it.
 */
export class AccountsFile extends Context.Service<
	AccountsFile,
	{
		/** The accounts, oldest first; none before the first `mx login`. A file mx cannot read fails loudly with its path. */
		readonly read: Effect.Effect<readonly Account[], CredentialFailed>;
		readonly write: (
			accounts: readonly Account[]
		) => Effect.Effect<void, CredentialFailed>;
	}
>()("mx/auth/config/AccountsFile") {
	static readonly layer = Layer.effect(
		AccountsFile,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { configFile } = yield* Paths;
			const failed = (error: { readonly message: string }) =>
				CredentialFailed.make({ message: error.message });

			const read = Effect.gen(function* () {
				if (!(yield* fs.exists(configFile))) {
					return [];
				}
				const saved = yield* fs.readFileString(configFile).pipe(
					Effect.flatMap(decodeConfig),
					Effect.mapError((error) =>
						CredentialFailed.make({
							message: `${configFile} does not name the accounts: ${error.message} Delete it and run mx login.`,
						})
					)
				);
				return "accounts" in saved
					? saved.accounts
					: [
							{
								alias: defaultAlias(saved.tenant),
								clientId: saved.clientId,
								id: 1,
								tenant: saved.tenant,
							},
						];
			}).pipe(
				Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error))),
				Effect.withSpan("AccountsFile.read")
			);

			const write = Effect.fn("AccountsFile.write")(
				function* (accounts: readonly Account[]) {
					const folder = path.dirname(configFile);
					yield* fs.makeDirectory(folder, { recursive: true });
					const staged = yield* fs.makeTempFileScoped({ directory: folder });
					yield* fs.writeFileString(
						staged,
						yield* encodeConfig({ accounts }).pipe(Effect.orDie)
					);
					yield* fs.rename(staged, configFile);
				},
				Effect.scoped,
				Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error)))
			);

			return AccountsFile.of({ read, write });
		})
	);
}

/** `MX_CLIENT_ID`: the client id a new account signs in with when `mx login` is given none. */
export const clientIdConfig = Config.option(
	Config.schema(ClientId, "MX_CLIENT_ID")
);

/** `MX_TENANT`: the tenant a new account signs in at when `mx login` is given none. */
export const tenantConfig = Config.option(Config.schema(Tenant, "MX_TENANT"));

/** Asks on the terminal with `prompt`; without a terminal it fails with `refusal`. */
export const ask = <A>(prompt: Prompt.Prompt<A>, refusal: string) =>
	Effect.flatMap(
		TerminalCapabilities.TerminalCapabilities,
		({
			canPrompt,
		}): Effect.Effect<
			A,
			Terminal.QuitError | CliError.UserError,
			Prompt.Environment
		> =>
			canPrompt
				? Prompt.run(prompt)
				: Effect.fail(
						CliError.UserError.make({ cause: undefined, userMessage: refusal })
					)
	);

/** Asks for a client id, where Enter keeps `kept` when there is one. */
export const askClientId = (kept: Option.Option<string>) =>
	ask(
		Prompt.String({
			message: Option.match(kept, {
				onNone: () => "Client id",
				onSome: (id) => `Client id. Enter keeps ${id}.`,
			}),
			validate: (value) =>
				Schema.decodeEffect(ClientId)(
					Str.trim(value) || Option.getOrElse(kept, () => "")
				).pipe(
					Effect.mapError(
						() =>
							"A client id is a GUID, such as 00000000-0000-0000-0000-000000000000."
					)
				),
		}),
		"mx can't ask for the client id here. Run mx login --client-id <client id>."
	);

/** Asks for a tenant, where Enter keeps `organizations`. */
export const askTenant = ask(
	Prompt.String({
		message: `Tenant: a domain such as contoso.com, or a tenant id. Enter keeps ${organizations}.`,
		validate: (value) =>
			Schema.decodeEffect(Tenant)(Str.trim(value) || organizations).pipe(
				Effect.mapError(
					() =>
						"A tenant is organizations, a tenant id, or a domain such as contoso.com."
				)
			),
	}),
	"mx can't ask for the tenant here. Run mx login --tenant <tenant>."
);

/** `--account`: the alias of the account to sign in to. */
export const accountFlag = Flag.String("account").pipe(
	Flag.optional,
	Flag.withDescription(
		"The alias of the account to sign in to. An alias mx has signs that account in again; a new one adds an account. With one account, mx signs in to it; with more, mx asks which."
	)
);

/** `--client-id`; without it, an account's own client id, or for a new account `MX_CLIENT_ID`, or else mx asks. */
export const clientIdFlag = Flag.String("client-id").pipe(
	Flag.withSchema(ClientId),
	Flag.optional,
	Flag.withDescription(
		"The client id to sign in with. mx asks for it once for each account and saves it."
	)
);

/** `--tenant`; without it, an account's own tenant, or for a new account `MX_TENANT`, or else mx asks. */
export const tenantFlag = Flag.String("tenant").pipe(
	Flag.withSchema(Tenant),
	Flag.optional,
	Flag.withDescription(
		"The tenant to sign in at: organizations, a tenant id, or a domain such as contoso.com. mx asks for it once for each account and saves it."
	)
);
