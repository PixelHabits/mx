import {
	Array as Arr,
	Config,
	Effect,
	FileSystem,
	Option,
	Path,
	Record as Rec,
	Result,
	Schema,
} from "effect";
import { CliError, Flag, Prompt } from "effect/cli";
import { InstallFailed } from "./errors.ts";
import { type Approval, recommendedApprovals } from "./mcp/server.ts";
import { Paths } from "./paths.ts";

/** The agents `mx install` sets up to start `mx mcp`. */
export const agentIds = ["claude-desktop", "claude-code", "codex"] as const;
export type AgentId = (typeof agentIds)[number];

/** A file mx changes for an agent: its text with mx set up, or with mx taken out; none when the text stays as it is. */
export interface ConfigFile {
	/** What of mx the file holds, as `mx uninstall` names it. */
	readonly holds: string;
	/** The text mx starts from when the file does not exist yet; none when the agent has to write it first. */
	readonly initial: Option.Option<string>;
	readonly path: string;
	readonly setUp: (
		text: string
	) => Effect.Effect<Option.Option<string>, InstallFailed>;
	readonly takeOut: (
		text: string
	) => Effect.Effect<Option.Option<string>, InstallFailed>;
}

/** An agent on this machine and the files mx changes for it, the one it reads its MCP servers from first. */
export interface Agent {
	readonly app: string;
	/** What the user does so the agent writes the file it reads its MCP servers from. */
	readonly createConfig: string;
	readonly files: readonly [ConfigFile, ...ConfigFile[]];
	readonly id: AgentId;
}

/** How an agent starts `mx mcp`. */
interface McpEntry {
	readonly args: readonly string[];
	readonly command: string;
}

const desktopFile = "claude_desktop_config.json";

/**
 * Claude Desktop's config files, on Windows and macOS only. Anthropic documents one, in `%APPDATA%\Claude` on Windows
 * and in `~/Library/Application Support/Claude` on macOS. Claude Desktop from the Microsoft Store is a packaged app, so
 * Windows keeps a file it creates below `%APPDATA%` in `LocalCache\Roaming` of its package, `Claude_<publisher id>`,
 * and the app opens the file there before the one in `%APPDATA%`. These are each config that exists, the packaged ones
 * first, or the documented one when none does. Claude Desktop keeps tool approvals outside them, so mx sets none there.
 */
const desktopConfigs = Effect.gen(function* () {
	if (process.platform !== "win32" && process.platform !== "darwin") {
		return Option.none<Arr.NonEmptyReadonlyArray<string>>();
	}
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { appPackages, config } = yield* Paths;
	const packaged = yield* Option.match(appPackages, {
		onNone: () => Effect.succeed([]),
		onSome: (folder) =>
			Effect.gen(function* () {
				if (!(yield* fs.exists(folder))) {
					return [];
				}
				return Arr.map(
					Arr.filter(yield* fs.readDirectory(folder), (name) =>
						name.startsWith("Claude_")
					),
					(name) =>
						path.join(
							folder,
							name,
							"LocalCache",
							"Roaming",
							"Claude",
							desktopFile
						)
				);
			}),
	});
	const documented = path.join(config, "Claude", desktopFile);
	const found = yield* Effect.filter([...packaged, documented], (file) =>
		fs.exists(file)
	);
	return Option.some(Arr.isArrayNonEmpty(found) ? found : Arr.of(documented));
}).pipe(
	Effect.mapError((error) =>
		InstallFailed.make({
			message: `Could not look for Claude Desktop's config: ${error.message}`,
		})
	)
);

/** A JSON file with `mcpServers`, where the agent finds `mx`. */
const jsonServers = (path: string, entry: McpEntry): ConfigFile => ({
	holds: "mcpServers.mx",
	initial: Option.none(),
	path,
	setUp: (text) => editJson({ entry: Option.some(entry), file: path, text }),
	takeOut: (text) => editJson({ entry: Option.none(), file: path, text }),
});

/** Codex's `config.toml`, with `[mcp_servers.mx]` and the approvals of its tools. */
const codexServers = (path: string, entry: McpEntry): ConfigFile => ({
	holds: "[mcp_servers.mx] with its tool tables",
	initial: Option.none(),
	path,
	setUp: (text) => editToml({ entry: Option.some(entry), file: path, text }),
	takeOut: (text) => editToml({ entry: Option.none(), file: path, text }),
});

/** Claude Code's user settings, where its permission rules approve tools; Claude Code writes the file on first need. */
const claudeCodePermissions = (path: string): ConfigFile => ({
	holds: "the permission rules that name mx",
	initial: Option.some("{}"),
	path,
	setUp: (text) => presetPermissions({ file: path, text }),
	takeOut: (text) => removePermissions({ file: path, text }),
});

/** The agents mx can set up here, each with the config files it reads. */
export const agents = Effect.gen(function* () {
	const path = yield* Path.Path;
	const paths = yield* Paths;
	const codexHome = yield* Config.option(Config.NonEmptyString("CODEX_HOME"));
	/** Claude Code keeps `.claude.json` and `settings.json` in `CLAUDE_CONFIG_DIR` when it is set. */
	const claudeConfigDir = yield* Config.option(
		Config.NonEmptyString("CLAUDE_CONFIG_DIR")
	);
	const entry: McpEntry = { args: ["mcp"], command: paths.bin };
	const offered: readonly Agent[] = [
		...Option.toArray(
			Option.map(
				yield* desktopConfigs,
				(files): Agent => ({
					app: "Claude Desktop",
					createConfig:
						"In Claude Desktop, open Settings › Developer › Edit Config, then run mx install again.",
					files: Arr.map(files, (file) => jsonServers(file, entry)),
					id: "claude-desktop",
				})
			)
		),
		{
			app: "Claude Code",
			createConfig: "Open Claude Code once, then run mx install again.",
			files: [
				jsonServers(
					path.join(
						Option.getOrElse(claudeConfigDir, () => paths.home),
						".claude.json"
					),
					entry
				),
				claudeCodePermissions(
					path.join(
						Option.getOrElse(claudeConfigDir, () =>
							path.join(paths.home, ".claude")
						),
						"settings.json"
					)
				),
			],
			id: "claude-code",
		},
		{
			app: "Codex",
			createConfig: "Open Codex once, then run mx install again.",
			files: [
				codexServers(
					path.join(
						Option.getOrElse(codexHome, () => path.join(paths.home, ".codex")),
						"config.toml"
					),
					entry
				),
			],
			id: "codex",
		},
	];
	return offered;
});

/**
 * Asks on the terminal which agents to set up, with each agent whose config file exists selected. Without a terminal it
 * fails with the ids `--agent` takes here.
 */
const ask = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const offered = yield* agents;
	if (process.stdin.isTTY !== true) {
		return yield* CliError.UserError.make({
			cause: undefined,
			userMessage: `There is no terminal to ask which agents to set up. Name each with --agent: ${Arr.join(
				Arr.map(offered, (agent) => agent.id),
				", "
			)}.`,
		});
	}
	const choices = yield* Effect.forEach(offered, (agent) =>
		Effect.map(fs.exists(agent.files[0].path), (exists) => ({
			description: agent.files[0].path,
			selected: exists,
			title: agent.app,
			value: agent.id,
		}))
	);
	return Prompt.MultiSelect({
		choices,
		// Effect's picker starts on its Select All/None row, so the second line says what Space and Enter do.
		message:
			"Which agents should use mx?\n  Space checks or unchecks one. Enter continues with the checked ones.",
		min: 1,
	});
}).pipe(
	Effect.provideServiceEffect(Paths, Paths.make),
	Effect.catchTags({
		ConfigError: (error) =>
			Effect.fail(CliError.UserError.make({ cause: error })),
		InstallFailed: (error) =>
			Effect.fail(CliError.UserError.make({ cause: error })),
		PlatformError: (error) =>
			Effect.fail(CliError.UserError.make({ cause: error })),
	})
);

/** `--agent`, once for each agent to set up; without it, `mx install` asks. */
export const agentFlag = Flag.Literals("agent", agentIds).pipe(
	Flag.atLeast(1),
	Flag.withDescription(
		"An agent to set up: claude-desktop (on Windows and macOS), claude-code or codex. Give it once for each. Without it, mx install asks."
	),
	Flag.withFallbackPrompt(ask)
);

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeEffect(Schema.fromJsonString(JsonObject));
const decodeObject = Schema.decodeUnknownEffect(Schema.UndefinedOr(JsonObject));
const encodeJson = Schema.encodeEffect(
	Schema.fromJsonString(JsonObject, { space: 2 })
);

/** A config file's text and the entry mx wants under the name `mx`, or none to remove it. */
interface Edit {
	readonly entry: Option.Option<McpEntry>;
	readonly file: string;
	readonly text: string;
}

/** The servers with `mx` set to `entry` or removed; `mx` keeps its place among them. */
const withEntry = (
	servers: Record<string, unknown>,
	entry: Option.Option<unknown>
): Record<string, unknown> => {
	const { mx: _, ...others } = servers;
	return Option.match(entry, {
		onNone: () => others,
		onSome: (mx) => ({ ...servers, mx }),
	});
};

/**
 * The JSON config with `mcpServers.mx` set or removed and every other key as it was; none when there is no entry to
 * remove. Setting it replaces the command and args and keeps the entry's other keys, such as `env`.
 */
const editJson = ({ entry, file, text }: Edit) =>
	Effect.gen(function* () {
		const settings = yield* decodeJsonObject(text);
		const servers = (yield* decodeObject(settings.mcpServers)) ?? {};
		const current = yield* decodeObject(servers.mx);
		if (Option.isNone(entry) && current === undefined) {
			return Option.none<string>();
		}
		return Option.some(
			yield* encodeJson({
				...settings,
				mcpServers: withEntry(
					servers,
					Option.map(entry, ({ args, command }) => ({
						...current,
						args,
						command,
					}))
				),
			})
		);
	}).pipe(
		Effect.mapError((error) =>
			InstallFailed.make({
				message: `${file} is not a JSON object with an mcpServers object: ${error.message}`,
			})
		)
	);

/** A table header, `[name]` or `[[name]]`; the name is its dotted key with the spaces around dots removed. */
const tableHeader = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/u;
const dotSpacing = /\s*\.\s*/gu;
const quotedBareKey = /"([\w-]+)"/gu;

const tableName = (line: string) =>
	Option.map(Option.fromNullishOr(tableHeader.exec(line)?.[1]), (name) =>
		name.trim().replaceAll(dotSpacing, ".").replaceAll(quotedBareKey, "$1")
	);

const isMxTable = (name: string) =>
	name === "mcp_servers.mx" || name.startsWith("mcp_servers.mx.");

const isBlank = (line: string) => line.trim() === "";

/** A line that holds a key or a value, not only space or a comment. */
const holdsValue = (line: string) =>
	!(isBlank(line) || line.trim().startsWith("#"));

/**
 * The text with every `[mcp_servers.mx]` and `[mcp_servers.mx.*]` table cut out and `section` where the first one stood,
 * or appended when there was none. The blank and comment lines after a table's last value introduce what follows, so
 * they stay.
 */
const replaceMxTables = (text: string, section: readonly string[]) => {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const kept: string[] = [];
	let table: string[] | undefined;
	let placed = false;
	const closeTable = (lines: readonly string[]) => {
		const trailing = lines.slice(
			Option.getOrElse(Arr.findLastIndex(lines, holdsValue), () => 0) + 1
		);
		if (!placed) {
			kept.push(...section);
			placed = true;
		}
		const previous = kept.at(-1);
		kept.push(
			...(previous === undefined || isBlank(previous)
				? Arr.dropWhile(trailing, isBlank)
				: trailing)
		);
	};
	for (const line of text.split(eol)) {
		const name = tableName(line);
		if (Option.isSome(name)) {
			if (table !== undefined) {
				closeTable(table);
				table = undefined;
			}
			if (isMxTable(name.value)) {
				table = [line];
				continue;
			}
		}
		if (table === undefined) {
			kept.push(line);
		} else {
			table.push(line);
		}
	}
	if (table !== undefined) {
		closeTable(table);
	}
	if (placed || section.length === 0) {
		return Arr.join(kept, eol);
	}
	const before = text.trimEnd();
	return `${before}${before === "" ? "" : `${eol}${eol}`}${Arr.join(section, eol)}${eol}`;
};

const parseToml = (text: string) =>
	Effect.try({
		catch: (error) => (error instanceof Error ? error.message : String(error)),
		try: (): unknown => Bun.TOML.parse(text),
	}).pipe(
		Effect.flatMap((parsed) =>
			Schema.decodeUnknownEffect(JsonObject)(parsed).pipe(
				Effect.mapError((error) => error.message)
			)
		)
	);

/** The settings with `mcp_servers` replaced by `servers`; an empty `mcp_servers` counts as none, as TOML may drop it. */
const withServers = (
	settings: Record<string, unknown>,
	servers: Record<string, unknown>
) => {
	const { mcp_servers: _, ...others } = settings;
	return Rec.isEmptyRecord(servers)
		? others
		: { ...others, mcp_servers: servers };
};

/** Codex's approval mode for each of mx's approvals, `approval_mode` under `[mcp_servers.<id>.tools.<tool>]`. */
const codexApproval = {
	allow: "approve",
	ask: "prompt",
} as const satisfies Record<Approval, string>;

const decodeTools = Schema.decodeUnknownEffect(
	Schema.UndefinedOr(Schema.Record(Schema.String, JsonObject))
);

/**
 * mx's Codex server: the one there with its command and args set and its other settings kept, and the recommended
 * approval for each tool that has none. A `default_tools_approval_mode` on the server is the user's approval for each
 * tool without its own, so then mx adds none.
 */
const codexServer = (
	current: Record<string, unknown>,
	{ args, command }: McpEntry
) =>
	Effect.map(decodeTools(current.tools), (found) => {
		const tools = found ?? {};
		const presets =
			current.default_tools_approval_mode === undefined
				? Arr.filter(
						recommendedApprovals,
						({ tool }) => tools[tool]?.approval_mode === undefined
					)
				: [];
		return {
			...current,
			args,
			command,
			...(Arr.isArrayNonEmpty(presets)
				? {
						tools: {
							...tools,
							...Rec.fromEntries(
								Arr.map(presets, ({ approval, tool }) => [
									tool,
									{ ...tools[tool], approval_mode: codexApproval[approval] },
								])
							),
						},
					}
				: {}),
		};
	});

/**
 * The TOML config with `[mcp_servers.mx]` set up or removed, edited as text so the comments and the layout people gave
 * the rest of the file stay; none when there is no entry to remove. Setting up replaces the command and args, keeps
 * every other setting and tool approval of `mx`, and adds the recommended approvals. Removing cuts out `mx` with its
 * subtables. The edit stands only when the edited file parses to the same settings with nothing but `mcp_servers.mx`
 * changed.
 */
const editToml = ({ entry, file, text }: Edit) =>
	Effect.gen(function* () {
		const settings = yield* parseToml(text);
		const servers =
			(yield* decodeObject(settings.mcp_servers).pipe(
				Effect.mapError((error) => error.message)
			)) ?? {};
		const current = yield* decodeObject(servers.mx).pipe(
			Effect.mapError((error) => error.message)
		);
		if (Option.isNone(entry) && current === undefined) {
			return Option.none<string>();
		}
		const wanted = Option.isSome(entry)
			? Option.some(
					yield* codexServer(current ?? {}, entry.value).pipe(
						Effect.mapError((error) => error.message)
					)
				)
			: Option.none();
		const section = Option.match(wanted, {
			onNone: () => [],
			onSome: (mx) =>
				Bun.TOML.stringify({ mcp_servers: { mx } }).trimEnd().split("\n"),
		});
		const edited = replaceMxTables(text, section);
		const after = yield* parseToml(edited).pipe(
			Effect.mapError(() => "the edited file does not parse")
		);
		const afterServers =
			(yield* decodeObject(after.mcp_servers).pipe(
				Effect.mapError((error) => error.message)
			)) ?? {};
		if (
			!Bun.deepEquals(
				withServers(after, afterServers),
				withServers(settings, withEntry(servers, wanted))
			)
		) {
			return yield* Effect.fail(
				"the edit would change settings other than mcp_servers.mx"
			);
		}
		return Option.some(edited);
	}).pipe(
		Effect.mapError((reason) =>
			InstallFailed.make({
				message: `mx could not ${Option.isSome(entry) ? "set" : "remove"} [mcp_servers.mx] in ${file}, so it changed nothing there: ${reason}. ${Option.match(
					entry,
					{
						onNone: () => "Remove it by hand.",
						onSome: ({ command }) =>
							`Set command = "${command}" and args = ["mcp"] there by hand.`,
					}
				)}`,
			})
		)
	);

const decodeRules = Schema.decodeUnknownEffect(
	Schema.UndefinedOr(Schema.Array(Schema.String))
);

const notPermissions =
	(file: string) => (error: { readonly message: string }) =>
		InstallFailed.make({
			message: `${file} is not a JSON object whose permissions hold lists of rules: ${error.message}`,
		});

/** Claude Code's name for mx's tool in permission rules, `mcp__<server>__<tool>`. */
const ruleFor = (tool: string) => `mcp__mx__${tool}`;

/**
 * Whether a Claude Code permission rule applies to mx's tool: the tool's own rule, `mcp__mx` for every tool of the
 * server, or a glob such as `mcp__mx__*` that matches the tool's name. A rule with a specifier in parentheses is for
 * another tool, since Claude Code skips such rules for MCP tools.
 */
const covers = (rule: string, tool: string) =>
	rule === "mcp__mx" ||
	(!rule.includes("(") && new Bun.Glob(rule).match(ruleFor(tool)));

type Rules = Readonly<Record<Approval, readonly string[]>>;

/** The lists that gain a rule: the recommended one for each tool that no rule in `allow`, `ask` or `deny` covers yet. */
const withPresets = (lists: Rules, deny: readonly string[]) => {
	const existing = [...lists.allow, ...lists.ask, ...deny];
	const missing = Arr.filter(
		recommendedApprovals,
		({ tool }) => !Arr.some(existing, (rule) => covers(rule, tool))
	);
	return Rec.filter(
		Rec.map(lists, (rules, approval) => [
			...rules,
			...Arr.map(
				Arr.filter(missing, (preset) => preset.approval === approval),
				({ tool }) => ruleFor(tool)
			),
		]),
		(rules, approval) => rules.length > lists[approval].length
	);
};

/**
 * Claude Code's user settings with the recommended rules added and every other key as it was; none when no rule
 * changes. Claude Code checks deny, then ask, then allow, so a tool with any rule keeps the user's choice.
 */
const presetPermissions = ({
	file,
	text,
}: {
	readonly file: string;
	readonly text: string;
}) =>
	Effect.gen(function* () {
		const settings = yield* decodeJsonObject(text);
		const permissions = (yield* decodeObject(settings.permissions)) ?? {};
		const lists: Rules = {
			allow: (yield* decodeRules(permissions.allow)) ?? [],
			ask: (yield* decodeRules(permissions.ask)) ?? [],
		};
		const changed = withPresets(
			lists,
			(yield* decodeRules(permissions.deny)) ?? []
		);
		if (Rec.isEmptyRecord(changed)) {
			return Option.none<string>();
		}
		return Option.some(
			yield* encodeJson({
				...settings,
				permissions: { ...permissions, ...changed },
			})
		);
	}).pipe(Effect.mapError(notPermissions(file)));

/** Whether a Claude Code permission rule names mx: `mcp__mx`, or one of its tools as `mcp__mx__<tool>` or `mcp__mx__*`. */
const namesMx = (rule: string) =>
	rule === "mcp__mx" || rule.startsWith("mcp__mx__");

/** The lists of Claude Code's permission rules. */
const ruleLists = ["allow", "ask", "deny"] as const;

/**
 * Claude Code's user settings without a rule that names mx in `allow`, `ask` or `deny`, the user's own rules too, and
 * without a list that this leaves empty; every other key stays as it was. None when no rule names mx.
 */
const removePermissions = ({
	file,
	text,
}: {
	readonly file: string;
	readonly text: string;
}) =>
	Effect.gen(function* () {
		const settings = yield* decodeJsonObject(text);
		const permissions = (yield* decodeObject(settings.permissions)) ?? {};
		const lists = yield* Effect.forEach(ruleLists, (list) =>
			Effect.map(
				decodeRules(permissions[list]),
				(rules) => [list, rules ?? []] as const
			)
		);
		if (!Arr.some(lists, ([, rules]) => Arr.some(rules, namesMx))) {
			return Option.none<string>();
		}
		const kept: Partial<Record<string, readonly string[]>> = Rec.fromEntries(
			Arr.map(lists, ([list, rules]) => [
				list,
				Arr.filter(rules, (rule) => !namesMx(rule)),
			])
		);
		return Option.some(
			yield* encodeJson({
				...settings,
				permissions: Rec.filterMap(permissions, (value, key) => {
					const rules = kept[key];
					if (rules === undefined) {
						return Result.succeed(value);
					}
					return rules.length === 0 ? Result.failVoid : Result.succeed(rules);
				}),
			})
		);
	}).pipe(Effect.mapError(notPermissions(file)));
