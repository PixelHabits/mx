import {
	Array as Arr,
	type Cause,
	Context,
	Effect,
	type Layer,
	Queue,
	Schema,
	Sink,
	Stdio,
	Stream,
} from "effect";

const protocolVersion = "2026-07-28";

/** Every 2026-07-28 request names its protocol version and the client's capabilities; there is no handshake. */
const meta = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/clientInfo": { name: "mx-test", version: "1.0.0" },
	"io.modelcontextprotocol/protocolVersion": protocolVersion,
};

const Frame = Schema.Struct({
	error: Schema.optionalKey(Schema.Unknown),
	id: Schema.optionalKey(
		Schema.NullOr(Schema.Union([Schema.Int, Schema.String]))
	),
	method: Schema.optionalKey(Schema.String),
	result: Schema.optionalKey(Schema.Unknown),
});
const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Frame));
const encodeJson = (value: unknown) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
		Effect.orDie
	);

const ToolResult = Schema.Struct({
	content: Schema.Array(
		Schema.Struct({
			text: Schema.optionalKey(Schema.String),
			type: Schema.String,
		})
	),
	isError: Schema.optionalKey(Schema.Boolean),
	structuredContent: Schema.optionalKey(Schema.Unknown),
});

/**
 * A client of `mx mcp` over its stdio, as Claude Code or Codex runs it: newline-delimited JSON-RPC on MCP 2026-07-28.
 * `connect` returns the Stdio the server reads and writes and a client that sends one request at a time.
 */
export class McpClient extends Context.Service<
	McpClient,
	{
		/** The `result` of a request, or a defect with the JSON-RPC error. */
		readonly request: (
			method: string,
			params?: Record<string, unknown>
		) => Effect.Effect<unknown>;
		/** A `tools/call`: the text blocks joined, whether it is an error, and any structured content. */
		readonly call: (
			name: string,
			args: Record<string, unknown>
		) => Effect.Effect<{
			readonly isError: boolean;
			readonly structured: unknown;
			readonly text: string;
		}>;
	}
>()("mx/tests/mcp-client/McpClient") {}

/** A client that sends each request as one line through `send` and reads the server's lines from `lines`. */
const makeClient = (
	lines: Queue.Queue<string>,
	send: (line: string) => Effect.Effect<void>
) => {
	let nextId = 0;

	/** The next frame that answers request `id`, skipping notifications and other answers. */
	const answer = (id: number): Effect.Effect<typeof Frame.Type> =>
		Effect.flatMap(Queue.take(lines), decodeFrame).pipe(
			Effect.orDie,
			Effect.filterOrElse(
				(frame) => frame.id === id,
				() => answer(id)
			)
		);

	const request = Effect.fnUntraced(function* (
		method: string,
		params: Record<string, unknown> = {}
	) {
		nextId += 1;
		const id = nextId;
		const line = yield* encodeJson({
			id,
			jsonrpc: "2.0",
			method,
			params: { ...params, _meta: meta },
		});
		yield* send(`${line}\n`);
		const frame = yield* answer(id);
		if (frame.error !== undefined) {
			return yield* Effect.die(
				`${method} answered ${yield* encodeJson(frame.error)}`
			);
		}
		return frame.result;
	});

	const call = Effect.fnUntraced(function* (
		name: string,
		args: Record<string, unknown>
	) {
		const result = yield* Effect.flatMap(
			request("tools/call", { arguments: args, name }),
			Schema.decodeUnknownEffect(ToolResult)
		).pipe(Effect.orDie);
		return {
			isError: result.isError === true,
			structured: result.structuredContent,
			text: Arr.join(
				Arr.map(result.content, (block) => block.text ?? ""),
				"\n"
			),
		};
	});

	return McpClient.of({ call, request });
};

/** Offers each line of `stream` to `lines`, in a fiber of the scope. */
const readLines = <E>(stream: Stream.Stream<Uint8Array, E>) =>
	Effect.gen(function* () {
		const lines = yield* Queue.unbounded<string>();
		yield* stream.pipe(
			Stream.decodeText,
			Stream.splitLines,
			Stream.runForEach((line) => Queue.offer(lines, line)),
			Effect.forkScoped
		);
		return lines;
	});

/** A client and the Stdio of an `mx mcp` that runs in this process. */
export const connect = Effect.gen(function* () {
	const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();
	const stdout = yield* Queue.unbounded<string | Uint8Array, Cause.Done>();
	const encoder = new TextEncoder();
	const lines = yield* readLines(
		Stream.fromQueue(stdout).pipe(
			Stream.map((chunk) =>
				typeof chunk === "string" ? encoder.encode(chunk) : chunk
			)
		)
	);
	const stdio = Stdio.layerTest({
		stdin: Stream.fromQueue(stdin),
		stdout: () => Sink.fromQueue(stdout),
	});
	return {
		client: makeClient(lines, (line) =>
			Effect.asVoid(Queue.offer(stdin, encoder.encode(line)))
		),
		stdio: stdio satisfies Layer.Layer<Stdio.Stdio>,
	};
});

/** A client of `exe mcp`, started as its own process with `env`, which the scope stops. */
export const spawnClient = (exe: string, env: Record<string, string>) =>
	Effect.gen(function* () {
		const server = yield* Effect.acquireRelease(
			Effect.sync(() =>
				Bun.spawn([exe, "mcp"], {
					env,
					stderr: "inherit",
					stdin: "pipe",
					stdout: "pipe",
				})
			),
			(started) =>
				Effect.promise(() => {
					started.kill();
					return started.exited;
				})
		);
		const lines = yield* readLines(
			Stream.fromReadableStream({
				evaluate: () => server.stdout,
				onError: (error) => error,
			})
		);
		return makeClient(lines, (line) =>
			Effect.sync(() => {
				server.stdin.write(line);
				server.stdin.flush();
			})
		);
	});
