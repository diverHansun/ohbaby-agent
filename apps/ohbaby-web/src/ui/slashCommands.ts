import {
  filterSlashCommandCatalog,
  isWebPassthroughCommandId,
  type UiSlashCommandOutput,
  type UiWebCommandCatalog,
  type UiWebCommandSpec,
} from "ohbaby-sdk";
import type { UiContextWindowUsage } from "ohbaby-sdk";
import type { CommandNotice } from "../api/daemon/wire.js";
import type { HeaderModel, ViewModel } from "./selectors.js";

export interface SlashPaletteItem {
  readonly command: UiWebCommandSpec;
  readonly accent: "blue" | "gold" | "pink";
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
): readonly SlashPaletteItem[] {
  if (!draft.startsWith("/")) {
    return [];
  }
  const paletteCommands = catalog.commands.filter(isWebPaletteCommand);
  const paletteCatalog: UiWebCommandCatalog = {
    ...catalog,
    commands: paletteCommands,
  };
  const matchedIds = new Set(
    filterSlashCommandCatalog(paletteCatalog, draft, {
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
      accent: slashCommandAccent(command.category),
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

function isWebPaletteCommand(command: UiWebCommandSpec): boolean {
  return (
    command.action !== "executeCommand" || isWebPassthroughCommandId(command.id)
  );
}

export function slashCompletionSuffix(
  item: SlashPaletteItem | undefined,
  draft: string,
): string {
  if (!item || !draft || !item.label.startsWith(draft)) {
    return "";
  }
  return item.label.slice(draft.length);
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
  if (notice.kind !== "success" || notice.output?.kind !== "data") {
    return null;
  }
  switch (notice.output.subject) {
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

export function statusRows(
  data: Record<string, unknown> | null,
  header: HeaderModel,
  view: ViewModel,
): readonly { readonly label: string; readonly value: string }[] {
  const permission = isRecord(data?.permission) ? data.permission : undefined;
  const contextWindow = isRecord(data?.contextWindow)
    ? data.contextWindow
    : undefined;
  const model = isRecord(data?.model) ? data.model : undefined;
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
  return isSetupOverlay(command)
    ? "Setup"
    : (CATEGORY_LABELS[command.category] ?? "Command");
}

function categoryOrderForCommand(command: UiWebCommandSpec): number {
  return isSetupOverlay(command)
    ? CATEGORY_ORDER.setup
    : (CATEGORY_ORDER[command.category] ?? 100);
}

function isSetupOverlay(command: UiWebCommandSpec): boolean {
  return (
    command.action === "connectModel" || command.action === "connectSearch"
  );
}

function slashCommandAccent(category: string): SlashPaletteItem["accent"] {
  if (category === "session") {
    return "gold";
  }
  if (category === "system") {
    return "pink";
  }
  return "blue";
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
