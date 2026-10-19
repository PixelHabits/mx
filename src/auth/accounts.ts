import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
	Terminal,
} from "effect";
import { Hex } from "effect/encoding";
import { ChildProcessSpawner } from "effect/process";
import {
	type CredentialFailed,
	type MicrosoftUnavailable,
	Refused,
	type SignInFailed,
} from "../errors.ts";
import { Login, signIn as signInOnTerminal } from "./auth.ts";
import {
	type Account,
	AccountsFile,
	Alias,
	aliasRule,
	type Identity,
	listed,
} from "./config.ts";
import { Credentials } from "./credentials.ts";

/**
 * What `mx login` or `mx install` signs in to: `account` with the client id and the tenant to sign in with, `added`
 * when config.json does not name it yet, and `changed` when it names it with another client id or tenant.
 */
export interface Target {
	readonly account: Account;
	readonly added: boolean;
	readonly changed: boolean;
}

/** The account with the settings it signs in with and nothing of who signed in. */
const settingsOf = ({ alias, clientId, id, tenant }: Account): Account => ({
	alias,
	clientId,
	id,
	tenant,
});

/** The account as signed in by `identity`. */
const withIdentity = (account: Account, identity: Identity): Account => ({
	...settingsOf(account),
	...identity,
});

/** Whether mx does not know yet who signed in to the account. */
const unidentified = ({ oid, tid }: Account) =>
	oid === undefined || tid === undefined;

/** The account as a sentence names it: its alias, with its address once mx knows it. */
export const described = ({ address, alias }: Account) =>
	address === undefined ? alias : `${alias} (${address})`;

/** Why `alias` cannot name a new account, or none: it breaks the rules, or an account in `accounts` has it. */
export const aliasProblem = (
	accounts: readonly Account[],
	alias: string
): Option.Option<string> => {
	if (!Schema.is(Alias)(alias)) {
		return Option.some(aliasRule);
	}
	return Arr.some(accounts, (account) => account.alias === alias)
		? Option.some(`${alias} is already an account.`)
		: Option.none();
};

/** The refusal of an alias given on the command line that breaks the rules. */
export const notAnAlias = (alias: string) =>
	Refused.make({ message: `${alias} cannot be an alias. ${aliasRule}` });

/**
 * The accounts mx signs in to, as config.json names them, with their sign-ins. A mailbox is one account at most:
 * Microsoft names the tenant and the user of each sign-in, and mx refuses a sign-in whose pair another account has.
 */
export class Accounts extends Context.Service<
	Accounts,
	{
		/**
		 * Signs `target` in with a device code and saves the sign-in and who signed in. A changed client id or tenant deletes
		 * the account's saved sign-in first, since a refresh token works only with the ones it was issued for. Each other
		 * account that config.json names without who signed in, as one from an older config.json, learns it first through
		 * one refresh of its sign-in, so the new sign-in is checked against every account.
		 */
		readonly signIn: (
			target: Target
		) => Effect.Effect<
			void,
			Refused | SignInFailed | MicrosoftUnavailable | CredentialFailed
		>;
		/** Whether the account has a saved sign-in. */
		readonly signedIn: (
			account: number
		) => Effect.Effect<boolean, CredentialFailed>;
		/** Gives the account aliased `from` the alias `to`. */
		readonly rename: (
			from: string,
			to: string
		) => Effect.Effect<void, Refused | CredentialFailed>;
	}
>()("mx/auth/accounts") {
	static readonly layerNoDeps = Layer.effect(
		Accounts,
		Effect.gen(function* () {
			const file = yield* AccountsFile;
			const credentials = yield* Credentials;
			const login = yield* Login;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const terminal = yield* Terminal.Terminal;

			/** Writes each of `changed` over the account of its id, or after the others when it is new, reading config.json again first. */
			const save = (changed: readonly Account[]) =>
				Effect.flatMap(file.read, (saved) =>
					file.write([
						...Arr.map(saved, (account) =>
							Option.getOrElse(
								Arr.findFirst(changed, ({ id }) => id === account.id),
								() => account
							)
						),
						...Arr.filter(
							changed,
							({ id }) => !Arr.some(saved, (account) => account.id === id)
						),
					])
				);

			/** The account with who signed in, through one refresh of its saved sign-in that asks for the OpenID scopes. */
			const identify = (account: Account) =>
				Effect.gen(function* () {
					const saved = yield* credentials.read(account.id);
					const { identity, refreshToken } = yield* login.identify(saved);
					yield* credentials.write(account.id, { ...saved, refreshToken });
					return withIdentity(account, identity);
				}).pipe(
					Effect.catchTag("LoginRequired", (error) =>
						Refused.make({
							message: `mx cannot tell whether this mailbox is already ${account.alias}: ${error.reason} Run mx login --account ${account.alias} first.`,
						})
					)
				);

			/** Every account but `id`, each with who signed in to it; the ones mx learned it for are saved. */
			const others = Effect.fnUntraced(function* (id: number) {
				const saved = Arr.filter(
					yield* file.read,
					(account) => account.id !== id
				);
				const learned = yield* Effect.forEach(
					Arr.filter(saved, unidentified),
					identify
				);
				if (Arr.isReadonlyArrayNonEmpty(learned)) {
					yield* save(learned);
				}
				return [
					...Arr.filter(saved, (account) => !unidentified(account)),
					...learned,
				];
			});

			const signIn = Effect.fn("Accounts.signIn")(function* ({
				account,
				changed,
			}: Target) {
				if (changed) {
					yield* credentials.remove(account.id);
					yield* save([settingsOf(account)]);
				}
				const accounts = yield* others(account.id);
				const started = yield* login.start(account);
				const complete = Effect.flatMap(
					started.complete,
					({ identity, refreshToken }) =>
						Effect.gen(function* () {
							const same = Arr.findFirst(
								accounts,
								({ oid, tid }) => oid === identity.oid && tid === identity.tid
							);
							if (Option.isSome(same)) {
								return yield* Refused.make({
									message: `${identity.address ?? "This mailbox"} is already the account ${same.value.alias}. mx saved nothing.`,
								});
							}
							yield* credentials.write(account.id, {
								clientId: account.clientId,
								id: Hex.encode(crypto.getRandomValues(new Uint8Array(16))),
								refreshToken,
								tenant: account.tenant,
							});
							yield* save([withIdentity(account, identity)]);
						})
				);
				yield* signInOnTerminal(
					{ spawner, terminal },
					{ ...started, complete }
				);
			});

			const signedIn = (account: number) =>
				credentials.read(account).pipe(
					Effect.as(true),
					Effect.catchTag("LoginRequired", () => Effect.succeed(false))
				);

			const rename = Effect.fn("Accounts.rename")(function* (
				from: string,
				to: string
			) {
				const saved = yield* file.read;
				if (!Arr.some(saved, ({ alias }) => alias === from)) {
					return yield* Refused.make({
						message: Arr.isReadonlyArrayNonEmpty(saved)
							? `No account ${from}. The accounts are ${listed.format(Arr.map(saved, ({ alias }) => alias))}.`
							: `No account ${from}. mx has no accounts; run mx login.`,
					});
				}
				if (!Schema.is(Alias)(to)) {
					return yield* notAnAlias(to);
				}
				const problem = aliasProblem(saved, to);
				if (Option.isSome(problem)) {
					return yield* Refused.make({ message: problem.value });
				}
				yield* file.write(
					Arr.map(saved, (account) =>
						account.alias === from ? { ...account, alias: to } : account
					)
				);
			});

			return Accounts.of({ rename, signedIn, signIn });
		})
	);

	static readonly layer = Accounts.layerNoDeps.pipe(
		Layer.provide(
			Layer.mergeAll(AccountsFile.layer, Credentials.layer, Login.layer)
		)
	);
}
