import type {
  UiContextWindowUsage,
  UiPromptCacheUsage,
  UiPermissionMode,
  UiPermissionLevel,
} from "ohbaby-sdk";
import {
  filterSlashCommandCatalog,
  isWebPassthroughCommandId,
  type UiSlashCommandOutput,
  type UiWebCommandCatalog,
  type UiWebCommandSpec,
} from "ohbaby-sdk";
import type { CommandNotice } from "../../api/daemon/wire.js";

export interface SlashPaletteItem {
  readonly command: UiWebCommandSpec;
  readonly action: UiWebCommandSpec["action"];
  readonly argsHint: string;
  readonly categoryLabel: string;
  readonly description: string;
  readonly executionKind: UiWebCommandSpec["executionKind"];
  readonly label: string;
  readonly showCategory: boolean;
}

export interface CommandResultModel {
  readonly commandLabel: string;
  readonly title: string;
  readonly variant: "help" | "mcps" | "skills" | "status";
}

const CATEGORY_LABELS: Record<string, string> = {
  setup: "Setup",
  skill: "Tools",
  skills: "Tools",
  session: "Session",
  system: "System",
  tools: "Tools",
};

const CATEGORY_ORDER: Record<string, number> = {
  setup: 10,
  session: 20,
  skill: 30,
  skills: 30,
  tools: 30,
  system: 40,
};

export function createSlashPaletteItems(
  catalog: UiWebCommandCatalog,
  draft: string,
  options: {
    /** After a skill token, and in the message editor: skills only. */
    readonly skillsOnly?: boolean;
  } = {},
): readonly SlashPaletteItem[] {
  if (!draft.startsWith("/")) {
    return [];
  }
  // Only skills can follow: match the `/name` just typed, not the request
  // it was typed in front of (`/co重点…` looks for `co`).
  const query = options.skillsOnly ? skillQuery(draft) : draft;
  const paletteCommands = catalog.commands.filter(
    (command) =>
      isWebPaletteCommand(command) &&
      (!options.skillsOnly || command.executionKind === "skill"),
  );
  const paletteCatalog: UiWebCommandCatalog = {
    ...catalog,
    commands: paletteCommands,
  };
  const matchedIds = new Set(
    filterSlashCommandCatalog(paletteCatalog, query, {
      surface: "tui",
    }).map((command) => command.id),
  );
  const commands = paletteCommands
    .filter((command) => matchedIds.has(command.id))
    .sort(compareSlashCommands);
  let previousCategory = "";
  return commands.map((command) => {
    const categoryLabel = categoryLabelForCommand(command);
    const showCategory = categoryLabel !== previousCategory;
    previousCategory = categoryLabel;
    return {
      action: command.action,
      argsHint: command.argsHint ?? "",
      categoryLabel,
      command,
      description: command.description,
      executionKind: command.executionKind,
      label: slashCommandLabel(command),
      showCategory,
    };
  });
}

/** Overlays, web-safe passthroughs and skills; never other TUI commands. */
function isWebPaletteCommand(command: UiWebCommandSpec): boolean {
  return (
    command.action !== "executeCommand" ||
    command.executionKind === "skill" ||
    isWebPassthroughCommandId(command.id)
  );
}

/** The skill a palette row calls, or undefined for any other command. */
export function paletteSkillName(
  item: SlashPaletteItem | undefined,
): string | undefined {
  return item?.executionKind === "skill" ? item.command.path[0] : undefined;
}

// Skill names are lowercase words joined by hyphens; uppercase is allowed
// because the catalog matches names case-insensitively.
const SKILL_QUERY = /^\/[A-Za-z0-9-]*/u;

function skillQuery(draft: string): string {
  return SKILL_QUERY.exec(draft)?.[0] ?? draft;
}

/** The request left once the `/query` typed to find a skill is replaced. */
export function dropSlashQuery(draft: string): string {
  return draft.slice(skillQuery(draft).length).replace(/^\s/u, "");
}

export function selectedSlashItem(
  items: readonly SlashPaletteItem[],
  selectedIndex: number,
): SlashPaletteItem | undefined {
  return items[Math.max(0, Math.min(selectedIndex, items.length - 1))];
}

export function slashCommandLabel(command: UiWebCommandSpec): string {
  return `/${command.path.join(" ")}`;
}

export function createCommandResultModel(
  notice: CommandNotice,
): CommandResultModel | null {
  switch (
    notice.output?.kind === "data" ? notice.output.subject : notice.commandId
  ) {
    case "help":
      return commandResultModel(notice, "Help", "help");
    case "mcps":
      return commandResultModel(notice, "MCP servers", "mcps");
    case "skills":
      return commandResultModel(notice, "Skills", "skills");
    case "status":
      return commandResultModel(notice, "Status", "status");
    default:
      return null;
  }
}

export function commandData(
  notice: CommandNotice,
): Record<string, unknown> | null {
  return notice.output?.kind === "data" ? notice.output.data : null;
}

export function commandDataArray(
  data: Record<string, unknown> | null,
  key: string,
): readonly unknown[] {
  const value = data?.[key];
  return Array.isArray(value) ? value : [];
}

export function safeHelpCommands(
  data: Record<string, unknown> | null,
): readonly Record<string, unknown>[] {
  return commandDataArray(data, "commands").filter(
    (command): command is Record<string, unknown> =>
      isRecord(command) &&
      typeof command.id === "string" &&
      isWebPassthroughCommandId(command.id),
  );
}

export interface CommandStatusHeader {
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly contextLabel: string;
  readonly modelLabel: string;
  readonly connectionKind: string;
}

export interface CommandStatusContext {
  readonly activeSession: { readonly title: string } | null;
  readonly composer: {
    readonly activeSessionId?: string;
    readonly mode: UiPermissionMode;
    readonly permissionLevel: UiPermissionLevel;
  };
}

export function statusRows(
  data: Record<string, unknown> | null,
  header: CommandStatusHeader,
  view: CommandStatusContext,
): readonly { readonly label: string; readonly value: string }[] {
  const permission = isRecord(data?.permission) ? data.permission : undefined;
  const contextWindow = isRecord(data?.contextWindow)
    ? data.contextWindow
    : undefined;
  const model = isRecord(data?.model) ? data.model : undefined;
  const promptCacheUsage = statusPromptCacheUsage(data);
  const rows = [
    {
      label: "session",
      value:
        stringValue(data?.sessionId) ??
        view.activeSession?.title ??
        view.composer.activeSessionId ??
        "none",
    },
    {
      label: "model",
      value:
        stringValue(model?.model) ??
        stringValue(model?.modelId) ??
        header.modelLabel,
    },
    {
      label: "context",
      value:
        formatContextWindow(contextWindow) ??
        (header.contextLabel === "0 / 0" ? "pending" : header.contextLabel),
    },
    ...(promptCacheUsage === null
      ? []
      : [
          {
            label: "cache",
            value: formatPromptCacheUsage(promptCacheUsage),
          },
        ]),
    { label: "connection", value: header.connectionKind },
    {
      label: "permission",
      value: `${stringValue(permission?.mode) ?? view.composer.mode} · ${
        stringValue(permission?.level) ?? view.composer.permissionLevel
      }`,
    },
    {
      label: "working dir",
      value: stringValue(data?.projectRoot) ?? "unknown",
    },
    { label: "status", value: stringValue(data?.status) ?? "idle" },
  ];
  return rows.filter((row) => row.value.length > 0);
}

export function statusPromptCacheUsage(
  data: Record<string, unknown> | null,
): UiPromptCacheUsage | null {
  const value = isRecord(data?.promptCacheUsage)
    ? data.promptCacheUsage
    : undefined;
  const accountedInputTokens = nonNegativeInteger(value?.accountedInputTokens);
  const cacheReadTokens = nonNegativeInteger(value?.cacheReadTokens);
  const sessionId = stringValue(value?.sessionId);
  const cacheReadShare = value?.cacheReadShare;
  if (
    accountedInputTokens === undefined ||
    cacheReadTokens === undefined ||
    sessionId === undefined ||
    cacheReadTokens > accountedInputTokens
  ) {
    return null;
  }
  if (accountedInputTokens === 0) {
    return cacheReadTokens === 0 && cacheReadShare === null
      ? {
          accountedInputTokens,
          cacheReadShare,
          cacheReadTokens,
          sessionId,
        }
      : null;
  }
  if (
    typeof cacheReadShare !== "number" ||
    !Number.isFinite(cacheReadShare) ||
    cacheReadShare < 0 ||
    cacheReadShare > 1
  ) {
    return null;
  }
  return {
    accountedInputTokens,
    cacheReadShare,
    cacheReadTokens,
    sessionId,
  };
}

export function statusContextWindowUsage(
  data: Record<string, unknown> | null,
): UiContextWindowUsage | null {
  const value = isRecord(data?.contextWindow) ? data.contextWindow : undefined;
  const currentTokens = nonNegativeNumber(value?.currentTokens);
  const contextWindowTokens = positiveNumber(value?.contextWindowTokens);
  const contextWindowRatio = nonNegativeNumber(value?.contextWindowRatio);
  const estimatedAt = stringValue(value?.estimatedAt);
  const modelId = stringValue(value?.modelId);
  const sessionId = stringValue(value?.sessionId);
  if (
    currentTokens === undefined ||
    contextWindowTokens === undefined ||
    contextWindowRatio === undefined ||
    estimatedAt === undefined ||
    modelId === undefined ||
    sessionId === undefined
  ) {
    return null;
  }
  const composition = contextComposition(value?.composition);
  return {
    ...(composition === undefined ? {} : { composition }),
    contextWindowRatio,
    contextWindowTokens,
    currentTokens,
    estimatedAt,
    modelId,
    sessionId,
  };
}

export function outputAsJson(output: UiSlashCommandOutput | undefined): string {
  if (!output) {
    return "";
  }
  return output.kind === "data"
    ? JSON.stringify(output.data, null, 2)
    : output.kind === "markdown"
      ? output.markdown
      : output.text;
}

function commandResultModel(
  notice: CommandNotice,
  title: string,
  variant: CommandResultModel["variant"],
): CommandResultModel {
  return {
    commandLabel:
      notice.path.length > 0 ? `/${notice.path.join(" ")}` : notice.commandId,
    title,
    variant,
  };
}

function compareSlashCommands(
  left: UiWebCommandSpec,
  right: UiWebCommandSpec,
): number {
  const categoryOrder =
    categoryOrderForCommand(left) - categoryOrderForCommand(right);
  if (categoryOrder !== 0) {
    return categoryOrder;
  }
  return slashCommandLabel(left).localeCompare(slashCommandLabel(right));
}

function categoryLabelForCommand(command: UiWebCommandSpec): string {
  return CATEGORY_LABELS[command.category] ?? "Command";
}

function categoryOrderForCommand(command: UiWebCommandSpec): number {
  return CATEGORY_ORDER[command.category] ?? 100;
}

function formatContextWindow(
  value: Record<string, unknown> | undefined,
): string | undefined {
  const current = numberValue(value?.currentTokens);
  const limit = numberValue(value?.contextWindowTokens);
  return current !== undefined && limit !== undefined
    ? `${compactNumber(current)} / ${compactNumber(limit)}`
    : undefined;
}

function formatPromptCacheUsage(usage: UiPromptCacheUsage): string {
  return usage.cacheReadShare === null
    ? "hit —"
    : `hit ${String(Math.round(usage.cacheReadShare * 100))}%`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${String(Math.round(value / 100_000) / 10)}m`;
  }
  if (value >= 1_000) {
    return `${String(Math.round(value / 100) / 10)}k`;
  }
  return String(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function contextComposition(
  value: unknown,
): UiContextWindowUsage["composition"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const systemPrompt = nonNegativeInteger(value["system-prompt"]);
  const builtinTools = nonNegativeInteger(value["builtin-tools"]);
  const mcp = nonNegativeInteger(value.mcp);
  const skills = nonNegativeInteger(value.skills);
  const conversation = nonNegativeInteger(value.conversation);
  const summarizedConversation = nonNegativeInteger(
    value["summarized-conversation"],
  );
  const subagentExchanges = nonNegativeInteger(value["subagent-exchanges"]);
  if (
    systemPrompt === undefined ||
    builtinTools === undefined ||
    mcp === undefined ||
    skills === undefined ||
    conversation === undefined ||
    summarizedConversation === undefined ||
    subagentExchanges === undefined
  ) {
    return undefined;
  }
  return {
    "system-prompt": systemPrompt,
    "builtin-tools": builtinTools,
    mcp,
    skills,
    conversation,
    "summarized-conversation": summarizedConversation,
    "subagent-exchanges": subagentExchanges,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
