import {
	Config,
	ConfigProvider,
	Effect,
	FileSystem,
	Option,
	Schema,
	String as Str,
} from "effect";
import { CliError, Flag, Prompt } from "effect/cli";
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

/** `config.json`: the client id and the tenant `mx login` saved. */
const ConfigFile = Schema.Struct({ clientId: ClientId, tenant: Tenant });
const decodeConfigFile = Schema.decodeEffect(Schema.fromJsonString(ConfigFile));
export const encodeConfigFile = Schema.encodeEffect(
	Schema.fromJsonString(ConfigFile, { space: 2 })
);

/** The client id: `MX_CLIENT_ID` in the environment, or else the one `mx login` saved. */
export const clientIdConfig = Config.schema(ClientId, "MX_CLIENT_ID");

/** The tenant: `MX_TENANT` in the environment, or else the one `mx login` saved. */
export const tenantConfig = Config.schema(Tenant, "MX_TENANT");

/** What `mx login` saved; none before the first one. A file mx cannot read fails loudly with its path. */
export const readSaved = ({
	configFile,
	fs,
}: {
	readonly configFile: string;
	readonly fs: FileSystem.FileSystem;
}) =>
	Effect.gen(function* () {
		if (!(yield* fs.exists(configFile))) {
			return Option.none<SignInConfig>();
		}
		const saved: SignInConfig = yield* fs.readFileString(configFile).pipe(
			Effect.flatMap(decodeConfigFile),
			Effect.mapError((error) =>
				CredentialFailed.make({
					message: `${configFile} does not hold a client id and a tenant: ${error.message} Delete it and run mx login.`,
				})
			)
		);
		return Option.some(saved);
	}).pipe(
		Effect.catchTag("PlatformError", (error) =>
			Effect.fail(CredentialFailed.make({ message: error.message }))
		)
	);

/**
 * Config reads the environment first and then what `mx login` saved, so `MX_CLIENT_ID` and `MX_TENANT` override the
 * saved values for a run, as `--client-id` and `--tenant` override both.
 */
export const savedConfig = ConfigProvider.layerAdd(
	Effect.gen(function* () {
		const saved = yield* readSaved({
			configFile: (yield* Paths).configFile,
			fs: yield* FileSystem.FileSystem,
		});
		return ConfigProvider.fromUnknown(
			Option.match(saved, {
				onNone: () => ({}),
				onSome: ({ clientId, tenant }) => ({
					MX_CLIENT_ID: clientId,
					MX_TENANT: tenant,
				}),
			})
		);
	})
);

/** Asks on the terminal with `prompt`; without a terminal it fails with `refusal`. */
const ask = (prompt: Prompt.Prompt<string>, refusal: string) =>
	Effect.suspend(() =>
		process.stdin.isTTY === true
			? Effect.succeed(prompt)
			: Effect.fail(
					CliError.UserError.make({ cause: undefined, userMessage: refusal })
				)
	);

/** `--client-id`; without it, the configured client id, or else mx asks for one. */
export const clientIdFlag = Flag.String("client-id").pipe(
	Flag.withSchema(ClientId),
	Flag.withDescription(
		"The client id to sign in with. mx asks for it once and saves it."
	),
	Flag.withFallbackConfig(clientIdConfig),
	Flag.withFallbackPrompt(
		ask(
			Prompt.String({
				message: "Client id",
				validate: (value) =>
					Schema.decodeEffect(ClientId)(Str.trim(value)).pipe(
						Effect.mapError(
							() =>
								"A client id is a GUID, such as 00000000-0000-0000-0000-000000000000."
						)
					),
			}),
			"There is no terminal to ask for the client id. Run mx login --client-id <client id>."
		)
	)
);

/** `--tenant`; without it, the configured tenant, or else mx asks for one, where Enter keeps `organizations`. */
export const tenantFlag = Flag.String("tenant").pipe(
	Flag.withSchema(Tenant),
	Flag.withDescription(
		"The tenant to sign in at: organizations, a tenant id, or a domain such as contoso.com. mx asks for it once and saves it."
	),
	Flag.withFallbackConfig(tenantConfig),
	Flag.withFallbackPrompt(
		ask(
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
			"There is no terminal to ask for the tenant. Run mx login --tenant <tenant>."
		)
	)
);
