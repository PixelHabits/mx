import {
	Clock,
	Console,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	pipe,
	Redacted,
	Schema,
	String as Str,
	Stream,
	SynchronizedRef,
	type Terminal,
} from "effect";
import { TerminalCapabilities } from "effect/cli";
import { Base64Url } from "effect/encoding";
import {
	HttpClient,
	type HttpClientError,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { copyToClipboard, openInBrowser } from "../desktop.ts";
import {
	type CredentialFailed,
	LoginRequired,
	MicrosoftUnavailable,
	SignInFailed,
} from "../errors.ts";
import { policy } from "../http-policy.ts";
import { AccountId, type Identity, type SignInConfig } from "./config.ts";
import { Credentials, type SignIn } from "./credentials.ts";

/** Delegated mail read, write and send, and a refresh token: what every refresh asks for. */
const graphScope =
	"https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access";

/** The Graph scopes and the OpenID ones, whose id token names who signed in, with no Graph permission of its own. */
const identityScope = `${graphScope} openid email profile`;

/** The sign-in endpoints of `tenant`; at `organizations`, Entra finds the user's tenant from the account that signs in. */
const authority = (tenant: string) =>
	`https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

const deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 polls every 5 seconds when the device-code answer names no interval, and 5 seconds slower on `slow_down`. */
const defaultPollInterval = Duration.seconds(5);

/** An access token is replaced this long before Microsoft says it expires. */
const refreshMargin = Duration.minutes(5);

/** OAuth errors that only a new interactive sign-in clears. */
const signInAgain = new Set(["invalid_grant", "interaction_required"]);

const Seconds = Schema.Int.check(Schema.isGreaterThan(0));

/** The device code arrives redacted: it can redeem the sign-in until it expires. */
const DeviceCode = Schema.Struct({
	device_code: Schema.RedactedFromValue(Schema.String),
	expires_in: Seconds,
	interval: Schema.optionalKey(Schema.Int),
	user_code: Schema.String,
	verification_uri: Schema.String,
});

/** The tokens arrive redacted, so no log, span or cause that carries the answer prints them. */
const Tokens = Schema.Struct({
	access_token: Schema.RedactedFromValue(Schema.String),
	expires_in: Seconds,
	refresh_token: Schema.RedactedFromValue(Schema.String),
});

/** The tokens of a request that asked for the OpenID scopes, with the id token that names who signed in. */
const IdentifiedTokens = Schema.Struct({
	...Tokens.fields,
	id_token: Schema.String,
});

/** The claims mx reads from an id token: the address, as `email` or else `preferred_username`, the tenant and the user. */
const Claims = Schema.fromJsonString(
	Schema.Struct({
		email: Schema.optionalKey(Schema.String),
		oid: Schema.String,
		preferred_username: Schema.optionalKey(Schema.String),
		tid: Schema.String,
	})
);

const OAuthError = Schema.Struct({ error: Schema.String });

/** The token endpoint's answer: the decoded body on a 2xx, or its status and OAuth error code. */
type Answer<A> =
	| { readonly _tag: "Answered"; readonly value: A }
	| {
			readonly _tag: "Refused";
			readonly code: string | undefined;
			readonly status: number;
	  };

/** A failure without its request: the token request's body holds a code or a refresh token. */
const unavailable = ({ reason }: HttpClientError.HttpClientError) =>
	MicrosoftUnavailable.make({
		cause: reason.cause,
		message: `The token request failed: ${reason._tag === "TransportError" && reason.description === "deadline" ? "deadline" : reason._tag}.`,
		reason: "token",
	});

const refusedToken = (status: number, code: string | undefined) =>
	MicrosoftUnavailable.make({
		code,
		message: `The token endpoint answered ${status}${code === undefined ? "" : ` ${code}`}.`,
		reason: "token",
		status,
	});

/**
 * Who the id token names. mx reads its payload without checking its signature: it came straight from the token endpoint
 * over TLS.
 */
const identityOf = (idToken: string) =>
	Effect.fromResult(
		Base64Url.decodeString(pipe(idToken, Str.split("."))[1] ?? "")
	).pipe(
		Effect.flatMap(Schema.decodeEffect(Claims)),
		Effect.map(({ email, oid, preferred_username, tid }): Identity => {
			const address = email ?? preferred_username;
			return { ...(address === undefined ? {} : { address }), oid, tid };
		}),
		Effect.mapError(() =>
			MicrosoftUnavailable.make({
				message: "The token endpoint answered an id token mx cannot read.",
				reason: "token",
			})
		)
	);

/** A new sign-in: its refresh token, and who signed in. */
export interface SignedIn {
	readonly identity: Identity;
	readonly refreshToken: Redacted.Redacted<string>;
}

/** The token endpoint's answer to `form` posted to `url`: the body decoded with `schema` on a 2xx, or the status and OAuth error code. */
type Post = <S extends Schema.Top>(
	url: string,
	form: Record<string, string>,
	schema: S
) => Effect.Effect<
	Answer<S["Type"]>,
	MicrosoftUnavailable,
	S["DecodingServices"]
>;

/** Posts to Microsoft's token endpoint; every token request is safe to repeat, since Entra keeps a used refresh token valid. */
const tokenEndpoint = Effect.map(HttpClient.HttpClient, (client): Post => {
	const transport = policy(client, { retryable: () => true });
	const answer = <S extends Schema.Top>(
		response: HttpClientResponse.HttpClientResponse,
		schema: S
	): Effect.Effect<
		Answer<S["Type"]>,
		MicrosoftUnavailable,
		S["DecodingServices"]
	> =>
		Effect.gen(function* () {
			const { status } = response;
			if (status >= 200 && status < 300) {
				const value = yield* HttpClientResponse.schemaBodyJson(schema)(
					response
				).pipe(Effect.mapError(() => refusedToken(status, undefined)));
				return { _tag: "Answered", value } as const;
			}
			const code = yield* HttpClientResponse.schemaBodyJson(OAuthError)(
				response
			).pipe(
				Effect.map(({ error }) => error),
				Effect.option
			);
			return {
				_tag: "Refused",
				code: Option.getOrUndefined(code),
				status,
			} as const;
		});
	return (url, form, schema) =>
		transport
			.execute(
				HttpClientRequest.post(url).pipe(
					HttpClientRequest.acceptJson,
					HttpClientRequest.bodyUrlParams(form)
				)
			)
			.pipe(
				Effect.flatMap((response) => answer(response, schema)),
				Effect.catchTag("HttpClientError", (error) =>
					Effect.fail(unavailable(error))
				)
			);
});

/** A refresh Microsoft refused: only a new sign-in helps after `invalid_grant` or `interaction_required`. */
const refusedRefresh = (status: number, code: string | undefined) =>
	code !== undefined && signInAgain.has(code)
		? LoginRequired.make({
				reason: `Microsoft refused the saved sign-in (${code}).`,
			})
		: refusedToken(status, code);

/** A cached access token, the id of the sign-in it came from, and the instant mx stops using it. */
interface Cached {
	readonly expiresAt: number;
	readonly signIn: string;
	readonly token: Redacted.Redacted<string>;
}

/**
 * Access tokens for Graph, refreshed from the saved sign-in of the account in `AccountId`, with the client id and the
 * tenant that sign-in was issued for. Entra returns a new refresh token on each refresh and does not revoke the old one,
 * so two processes refresh on their own and the last write wins. Each request reads the saved sign-in, so a process
 * that runs while `mx login` signs the account in again uses the new sign-in from its next request.
 */
export class Auth extends Context.Service<
	Auth,
	{
		/**
		 * Sends each request with a current access token. A 401 replaces the token and sends the request once more.
		 */
		readonly authorize: <E, R>(
			client: HttpClient.HttpClient.With<E, R>
		) => HttpClient.HttpClient.With<
			E | LoginRequired | CredentialFailed | MicrosoftUnavailable,
			R
		>;
	}
>()("mx/auth/auth") {
	static readonly layerNoDeps = Layer.effect(
		Auth,
		Effect.gen(function* () {
			const account = yield* AccountId;
			const credentials = yield* Credentials;
			const post = yield* tokenEndpoint;

			/**
			 * A new access token for the `saved` sign-in, with its rotated refresh token saved. When `mx login` saved another
			 * sign-in while the request ran, that one is refreshed instead, and its token stays.
			 */
			const refresh = (
				saved: SignIn
			): Effect.Effect<
				Cached,
				LoginRequired | CredentialFailed | MicrosoftUnavailable
			> =>
				Effect.gen(function* () {
					const refreshed = yield* post(
						`${authority(saved.tenant)}/token`,
						{
							client_id: saved.clientId,
							grant_type: "refresh_token",
							refresh_token: Redacted.value(saved.refreshToken),
							scope: graphScope,
						},
						Tokens
					);
					if (refreshed._tag === "Refused") {
						return yield* refusedRefresh(refreshed.status, refreshed.code);
					}
					const latest = yield* credentials.read(account);
					if (latest.id !== saved.id) {
						return yield* refresh(latest);
					}
					const tokens = refreshed.value;
					yield* credentials.write(account, {
						...saved,
						refreshToken: tokens.refresh_token,
					});
					const now = yield* Clock.currentTimeMillis;
					return {
						expiresAt:
							now +
							Duration.toMillis(
								Duration.subtract(
									Duration.seconds(tokens.expires_in),
									refreshMargin
								)
							),
						signIn: saved.id,
						token: tokens.access_token,
					} satisfies Cached;
				}).pipe(Effect.withSpan("Auth.refresh"));

			const cache = yield* SynchronizedRef.make(Option.none<Cached>());
			/**
			 * The cached access token while it came from the saved sign-in, has not expired and Graph did not refuse it,
			 * else a refreshed one.
			 */
			const accessToken = (
				rejected: Option.Option<Redacted.Redacted<string>>
			) =>
				SynchronizedRef.modifyEffect(cache, (cached) =>
					Effect.gen(function* () {
						const saved = yield* credentials.read(account);
						const now = yield* Clock.currentTimeMillis;
						if (
							Option.isSome(cached) &&
							cached.value.signIn === saved.id &&
							cached.value.expiresAt > now &&
							!Option.contains(rejected, cached.value.token)
						) {
							return [cached.value.token, cached] as const;
						}
						const fresh = yield* refresh(saved);
						return [fresh.token, Option.some(fresh)] as const;
					})
				);

			const authorize: Auth["Service"]["authorize"] = (client) =>
				HttpClient.transform(client, (_, request) =>
					Effect.gen(function* () {
						const token = yield* accessToken(Option.none());
						const response = yield* client.execute(
							HttpClientRequest.bearerToken(request, token)
						);
						if (response.status !== 401) {
							return response;
						}
						const replaced = yield* accessToken(Option.some(token));
						return yield* client.execute(
							HttpClientRequest.bearerToken(request, replaced)
						);
					})
				);

			return Auth.of({ authorize });
		})
	);

	static readonly layer = Auth.layerNoDeps.pipe(
		Layer.provide(Credentials.layer)
	);
}

/** A device-code sign-in under way: the code to enter at the URL, and `complete`, which waits for the user to enter it. */
export interface StartedLogin<E> {
	readonly complete: Effect.Effect<void, E>;
	readonly url: string;
	readonly userCode: string;
}

/**
 * Microsoft's sign-in for any account: the device-code flow, and the refresh that learns who signed in to a saved
 * sign-in. Both ask for the OpenID scopes along with Graph's, so the id token names who signed in.
 */
export class Login extends Context.Service<
	Login,
	{
		/** Asks the tenant for a device code; `complete` waits for the user to enter it and answers the new sign-in. */
		readonly start: (config: SignInConfig) => Effect.Effect<
			{
				readonly complete: Effect.Effect<
					SignedIn,
					SignInFailed | MicrosoftUnavailable
				>;
				readonly url: string;
				readonly userCode: string;
			},
			MicrosoftUnavailable
		>;
		/** Refreshes `signIn` with the OpenID scopes: who signed in, and the rotated refresh token. */
		readonly identify: (
			signIn: SignIn
		) => Effect.Effect<SignedIn, LoginRequired | MicrosoftUnavailable>;
	}
>()("mx/auth/auth/Login") {
	static readonly layer = Layer.effect(
		Login,
		Effect.gen(function* () {
			const post = yield* tokenEndpoint;

			const signedIn = ({
				id_token,
				refresh_token,
			}: typeof IdentifiedTokens.Type) =>
				Effect.map(
					identityOf(id_token),
					(identity): SignedIn => ({ identity, refreshToken: refresh_token })
				);

			const start = Effect.fn("Login.start")(function* ({
				clientId,
				tenant,
			}: SignInConfig) {
				const started = yield* post(
					`${authority(tenant)}/devicecode`,
					{ client_id: clientId, scope: identityScope },
					DeviceCode
				);
				if (started._tag === "Refused") {
					return yield* refusedToken(started.status, started.code);
				}
				const code = started.value;
				const poll = (
					interval: Duration.Duration
				): Effect.Effect<
					typeof IdentifiedTokens.Type,
					SignInFailed | MicrosoftUnavailable
				> =>
					Effect.sleep(interval).pipe(
						Effect.andThen(
							post(
								`${authority(tenant)}/token`,
								{
									client_id: clientId,
									device_code: Redacted.value(code.device_code),
									grant_type: deviceCodeGrant,
								},
								IdentifiedTokens
							)
						),
						Effect.flatMap((polled) => {
							if (polled._tag === "Answered") {
								return Effect.succeed(polled.value);
							}
							if (polled.code === "authorization_pending") {
								return poll(interval);
							}
							if (polled.code === "slow_down") {
								return poll(Duration.sum(interval, defaultPollInterval));
							}
							return Effect.fail(
								polled.code === undefined
									? refusedToken(polled.status, undefined)
									: SignInFailed.make({ code: polled.code })
							);
						})
					);
				const complete = poll(
					code.interval === undefined
						? defaultPollInterval
						: Duration.seconds(code.interval)
				).pipe(
					Effect.timeoutOrElse({
						duration: Duration.seconds(code.expires_in),
						orElse: () =>
							Effect.fail(SignInFailed.make({ code: "expired_token" })),
					}),
					Effect.flatMap(signedIn),
					Effect.withSpan("Login.complete")
				);
				return {
					complete,
					url: code.verification_uri,
					userCode: code.user_code,
				};
			});

			const identify = Effect.fn("Login.identify")(function* (saved: SignIn) {
				const refreshed = yield* post(
					`${authority(saved.tenant)}/token`,
					{
						client_id: saved.clientId,
						grant_type: "refresh_token",
						refresh_token: Redacted.value(saved.refreshToken),
						scope: identityScope,
					},
					IdentifiedTokens
				);
				if (refreshed._tag === "Refused") {
					return yield* refusedRefresh(refreshed.status, refreshed.code);
				}
				return yield* signedIn(refreshed.value);
			});

			return Login.of({ identify, start });
		})
	);
}

/**
 * The device-code sign-in `started`: prints the URL and the code, and waits for the user and for `complete`, which saves
 * the sign-in. On a terminal, as GitHub CLI does, it copies the code to the clipboard and opens the URL in the browser
 * when the user presses Enter. The sign-in finishes whenever the code is entered, also on another device with no key
 * pressed, and input that ends before Enter, as Esc and Ctrl+C end it in raw mode, interrupts it as Ctrl+C does anywhere
 * else.
 */
export const signIn = Effect.fnUntraced(function* <E>(
	{
		spawner,
		terminal,
	}: {
		readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
		readonly terminal: Terminal.Terminal;
	},
	{ complete, url, userCode }: StartedLogin<E>
) {
	if ((yield* TerminalCapabilities.TerminalCapabilities).canPrompt) {
		const copied = yield* copyToClipboard(spawner, userCode);
		yield* Console.log(
			copied
				? `Your sign-in code is ${userCode}. It is on your clipboard.`
				: `Your sign-in code is ${userCode}.`
		);
		yield* Console.log(
			`Press Enter to open ${url} in your browser, then ${copied ? "paste" : "enter"} the code there.`
		);
		// Reading stops at Enter, which ends raw mode, so Ctrl+C is a signal again while the sign-in waits on.
		const openOnEnter = Effect.gen(function* () {
			const enter = yield* Effect.scoped(
				Effect.flatMap(terminal.readInput, (input) =>
					Stream.fromQueue(input).pipe(
						Stream.filter(
							({ key }) => key.name === "return" || key.name === "enter"
						),
						Stream.runHead
					)
				)
			);
			if (Option.isNone(enter)) {
				return yield* Effect.interrupt;
			}
			if (!(yield* openInBrowser(spawner, url))) {
				yield* Console.log(`Could not open a browser. Open ${url} yourself.`);
			}
			return yield* Effect.never;
		});
		yield* Effect.raceFirst(complete, openOnEnter);
	} else {
		yield* Console.log(`Open ${url} and enter the code ${userCode}.`);
		yield* complete;
	}
	yield* Console.log("Signed in. The refresh token is saved.");
});
