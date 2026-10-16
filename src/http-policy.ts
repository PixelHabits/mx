import { Cause, Duration, Effect, Schedule } from "effect";
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from "effect/http";

/** The deadline for one attempt, body included, unless the caller names a longer one for a download. */
const requestDeadline = Duration.seconds(60);

/** How many times a request repeats after its first attempt. */
const retries = 3;

/** The time a retried request may spend waiting between its attempts, however long a `Retry-After` asks for. */
const retryWaits = Duration.seconds(120);

/** Reads the body inside the deadline so a stalled stream cannot outlive it. */
const buffered = Effect.fnUntraced(function* (
	response: HttpClientResponse.HttpClientResponse
) {
	const body = yield* response.arrayBuffer;
	return HttpClientResponse.fromWeb(
		response.request,
		new Response([204, 205, 304].includes(response.status) ? null : body, {
			headers: response.headers,
			status: response.status,
		})
	);
});

/** Fails at `duration` with the transport error a stalled request gets. */
const withDeadline = (
	duration: Duration.Input,
	request: HttpClientRequest.HttpClientRequest
) =>
	Effect.timeoutOrElse({
		duration,
		orElse: () =>
			Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({
						cause: new Cause.TimeoutError(),
						description: "deadline",
						request,
					}),
				})
			),
	});

const isRead = (request: HttpClientRequest.HttpClientRequest) =>
	request.method === "GET" || request.method === "HEAD";

/**
 * One deadline per attempt. A request a repeat cannot duplicate, a read by default, retries transient failures; any
 * other request retries only a 429, which tells the caller the request was not run. Both wait at least as long as a
 * `Retry-After` asks, and a retried request has an overall deadline of every attempt plus `retryWaits`.
 */
export const policy = (
	http: HttpClient.HttpClient,
	options: {
		readonly deadline?: Duration.Duration;
		readonly retryable?: (
			request: HttpClientRequest.HttpClientRequest
		) => boolean;
	} = {}
) => {
	const deadline = options.deadline ?? requestDeadline;
	const bounded = HttpClient.transform(http, (effect, request) =>
		effect.pipe(
			Effect.flatMap(buffered),
			withDeadline(deadline, request),
			Effect.provideService(HttpClient.TracerPropagationEnabled, false)
		)
	);
	const transient = HttpClient.retryTransient(bounded, {
		schedule: Schedule.exponential("1 second"),
		times: retries,
	});
	const throttled = HttpClient.retryTransient(bounded, {
		retryOn: "response-only",
		schedule: Schedule.exponential("1 second").pipe(
			Schedule.setInputType<HttpClientResponse.HttpClientResponse>(),
			Schedule.while(({ input }) => input.status === 429)
		),
		times: retries,
	});
	const overall = Duration.sum(
		Duration.times(deadline, retries + 1),
		retryWaits
	);
	const retryable = options.retryable ?? isRead;
	return HttpClient.makeWith<
		never,
		never,
		HttpClientError.HttpClientError,
		never
	>(
		Effect.flatMap((request) =>
			(retryable(request) ? transient : throttled)
				.execute(request)
				.pipe(withDeadline(overall, request))
		),
		Effect.succeed
	);
};

/** A 4xx is the service refusing the request, except 408 and 429, which say it is slow or busy; any other status says nothing about the request. */
export const isRefusalStatus = (status: number): boolean =>
	status >= 400 && status < 500 && status !== 408 && status !== 429;
