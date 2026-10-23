import { Schema } from "effect";

/**
 * No saved sign-in, or Microsoft refused it; only a new device-code sign-in helps. `account` names the account to sign in
 * to again when mx has several.
 */
export class LoginRequired extends Schema.TaggedError<
	LoginRequired,
	{ readonly brand: unique symbol }
>("mx/errors/LoginRequired")("LoginRequired", {
	account: Schema.optionalKey(Schema.String),
	reason: Schema.String,
}) {
	override get message() {
		return this.account === undefined
			? `${this.reason} Run mx login.`
			: `${this.reason} Run mx login --account ${this.account}.`;
	}
}

/** Microsoft ended the device-code sign-in with an OAuth error, such as `authorization_declined` or `expired_token`. */
export class SignInFailed extends Schema.TaggedError<
	SignInFailed,
	{ readonly brand: unique symbol }
>("mx/errors/SignInFailed")("SignInFailed", {
	code: Schema.String,
}) {
	override get message() {
		return `Microsoft ended the sign-in with ${this.code}.`;
	}
}

/**
 * Microsoft did not answer the request. `reason` says how far it got: `token`, the token request failed, with the
 * endpoint's `status` and OAuth error `code` when it answered; `answered`, Graph answered a 5xx, 408, 429 or a status
 * without its error body; `transport` or `deadline`, the connection failed or the deadline passed, and a write may have
 * reached Graph. A later request can succeed. No field holds a request, so no token travels with the error.
 */
export class MicrosoftUnavailable extends Schema.TaggedError<
	MicrosoftUnavailable,
	{ readonly brand: unique symbol }
>("mx/errors/MicrosoftUnavailable")("MicrosoftUnavailable", {
	cause: Schema.optional(Schema.Defect()),
	code: Schema.optional(Schema.String),
	message: Schema.String,
	reason: Schema.Literals(["token", "transport", "deadline", "answered"]),
	status: Schema.optional(Schema.Int),
}) {}

/** Graph refused the request with a 4xx other than 408 or 429, its error code and its message. */
export class GraphRefused extends Schema.TaggedError<
	GraphRefused,
	{ readonly brand: unique symbol }
>("mx/errors/GraphRefused")("GraphRefused", {
	code: Schema.String,
	detail: Schema.String,
	status: Schema.Int,
}) {
	override get message() {
		return `Microsoft Graph refused the request with ${this.status} ${this.code}: ${this.detail}`;
	}
}

/**
 * Graph answered a page of a folder's messages, a delta page or a page of their ids, that does not match its schema;
 * `issue` says where it differs.
 */
export class GraphUnreadable extends Schema.TaggedError<
	GraphUnreadable,
	{ readonly brand: unique symbol }
>("mx/errors/GraphUnreadable")("GraphUnreadable", {
	issue: Schema.String,
}) {
	override get message() {
		return `Microsoft Graph answered a page mx cannot read: ${this.issue}`;
	}
}

/** The secret store, the sign-in file or config.json could not be read or written; `message` says what failed. */
export class CredentialFailed extends Schema.TaggedError<
	CredentialFailed,
	{ readonly brand: unique symbol }
>("mx/errors/CredentialFailed")("CredentialFailed", {
	message: Schema.String,
}) {}

/** A tool input names nothing mx knows: a message id, a folder, an attachment number or a file. */
export class NotFound extends Schema.TaggedError<
	NotFound,
	{ readonly brand: unique symbol }
>("mx/errors/NotFound")("NotFound", {
	message: Schema.String,
}) {}

/**
 * mx refuses a request it could carry out, such as deleting a message that is not a draft through `delete_draft`, or
 * adding a mailbox that is already an account.
 */
export class Refused extends Schema.TaggedError<
	Refused,
	{ readonly brand: unique symbol }
>("mx/errors/Refused")("Refused", {
	message: Schema.String,
}) {}

/** Push notifications cannot run now: cloudflared is missing or failed, the tunnel is unreachable, or a subscription failed. */
export class PushUnavailable extends Schema.TaggedError<
	PushUnavailable,
	{ readonly brand: unique symbol }
>("mx/errors/PushUnavailable")("PushUnavailable", {
	message: Schema.String,
}) {}

/** `mx install`, `mx uninstall` or `mx update` could not finish a step; `message` says which and why. */
export class InstallFailed extends Schema.TaggedError<
	InstallFailed,
	{ readonly brand: unique symbol }
>("mx/errors/InstallFailed")("InstallFailed", {
	message: Schema.String,
}) {}

/** `mx update` refused a release, or could not fetch or install it; `message` says which. */
export class UpdateFailed extends Schema.TaggedError<
	UpdateFailed,
	{ readonly brand: unique symbol }
>("mx/errors/UpdateFailed")("UpdateFailed", {
	message: Schema.String,
}) {}

/** The mail store records a migration this mx does not know: a newer mx wrote it, and only a newer mx can open it. */
export class NewerStore extends Schema.TaggedError<
	NewerStore,
	{ readonly brand: unique symbol }
>("mx/errors/NewerStore")("NewerStore", {}) {
	override get message() {
		return "This mail store was written by a newer mx. Run mx update.";
	}
}

/** `mx sync --once` could not sync some of several accounts; `message` names each, a line apiece, and why. */
export class SyncFailed extends Schema.TaggedError<
	SyncFailed,
	{ readonly brand: unique symbol }
>("mx/errors/SyncFailed")("SyncFailed", {
	message: Schema.String,
}) {}

/** `mx status` found mx sync stopped or reporting an error; `message` says which. */
export class SyncUnhealthy extends Schema.TaggedError<
	SyncUnhealthy,
	{ readonly brand: unique symbol }
>("mx/errors/SyncUnhealthy")("SyncUnhealthy", {
	message: Schema.String,
}) {}
