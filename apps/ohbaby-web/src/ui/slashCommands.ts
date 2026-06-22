import {
  filterSlashCommandCatalog,
  filterWebPassthroughCommandCatalog,
  isWebPassthroughCommandId,
  type UiSlashCommandCatalog,
  type UiSlashCommandOutput,
  type UiSlashCommandSpec,
} from "ohbaby-sdk";
import type { CommandNotice } from "../api/daemon/wire.js";
import type { HeaderModel, ViewModel } from "./selectors.js";

export interface SlashPaletteItem {
  readonly command: UiSlashCommandSpec;
  readonly accent: "blue" | "gold" | "pink";
  readonly argsHint: string;
  readonly categoryLabel: string;
  readonly description: string;
  readonly label: string;
  readonly showCategory: boolean;
}

export interface CommandResultModel {
  readonly commandLabel: string;
  readonly title: string;
  readonly variant: "help" | "mcps" | "skills" | "status";
}

const CATEGORY_LABELS: Record<string, string> = {
  skill: "Tools",
  skills: "Tools",
  session: "Session",
  system: "System",
  tools: "Tools",
};

const CATEGORY_ORDER: Record<string, number> = {
  session: 20,
  skill: 30,
  skills: 30,
  tools: 30,
  system: 40,
};

export function createSlashPaletteItems(
  catalog: UiSlashCommandCatalog,
  draft: string,
): readonly SlashPaletteItem[] {
  if (!draft.startsWith("/")) {
    return [];
  }
  const safeCatalog = filterWebPassthroughCommandCatalog(catalog, {
    surface: "tui",
  });
  const commands = filterSlashCommandCatalog(safeCatalog, draft, {
    surface: "tui",
  }).sort(compareSlashCommands);
  let previousCategory = "";
  return commands.map((command) => {
    const categoryLabel = CATEGORY_LABELS[command.category] ?? "Command";
    const showCategory = categoryLabel !== previousCategory;
    previousCategory = categoryLabel;
    return {
      accent: slashCommandAccent(command.category),
      argsHint: command.argsHint ?? "",
      categoryLabel,
      command,
      description: command.description,
      label: slashCommandLabel(command),
      showCategory,
    };
  });
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

export function slashCommandLabel(command: UiSlashCommandSpec): string {
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
  left: UiSlashCommandSpec,
  right: UiSlashCommandSpec,
): number {
  const categoryOrder =
    (CATEGORY_ORDER[left.category] ?? 100) -
    (CATEGORY_ORDER[right.category] ?? 100);
  if (categoryOrder !== 0) {
    return categoryOrder;
  }
  return slashCommandLabel(left).localeCompare(slashCommandLabel(right));
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
