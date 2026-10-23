import { Context, Duration, Effect, Layer, LayerMap } from "effect";
import { Auth } from "./auth/auth.ts";
import { AccountId } from "./auth/config.ts";
import { Credentials } from "./auth/credentials.ts";
import { Graph } from "./graph/graph.ts";
import { Store } from "./store.ts";
import { Sync } from "./sync.ts";

/**
 * Each account's mailbox, by account id: its Graph, which sends the account's own access token, and its Sync, which
 * files what it reads under the account in the one store every account shares. An account's services are built when a
 * process first asks for them and kept while it runs, so the account keeps one access token and runs one pass at a time.
 */
export class Mailboxes extends LayerMap.Service<Mailboxes>()("mx/mailboxes", {
	dependencies: [Store.layer, Credentials.layer],
	idleTimeToLive: Duration.infinity,
	// Every lookup builds the same Sync, Graph and Auth layers with another AccountId, and the map's lookups share one
	// memo map, which would hand each account the first account's services; fresh builds each account's own.
	lookup: (account: number) =>
		Layer.fresh(
			Sync.layerNoDeps.pipe(
				Layer.provideMerge(Graph.layerNoDeps),
				Layer.provide(Auth.layerNoDeps),
				Layer.provideMerge(Layer.succeed(AccountId, account))
			)
		),
}) {}

/** The Graph and the Sync of the account. */
export const mailbox = (account: number) =>
	Effect.map(Mailboxes.contextEffect(account), (services) => ({
		graph: Context.get(services, Graph),
		sync: Context.get(services, Sync),
	}));
