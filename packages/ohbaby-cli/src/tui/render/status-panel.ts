import type { UiContextWindowUsage } from "ohbaby-sdk";
import { formatContextWindowUsage } from "./usage.js";

const LABEL_WIDTH = 8;

interface CountLabel {
  readonly count: number | undefined;
  readonly label: string;
}

interface PresentCountLabel {
  readonly count: number;
  readonly label: string;
}

export function renderStatusPanel(data: Record<string, unknown>): string {
  const rows: string[] = [
    row("Runtime", getString(data, "status") ?? "unknown"),
  ];
  const sessionId = getString(data, "sessionId");
  const model = formatModelLabel(getRecord(data, "model"));
  const tools = formatTools(getRecord(data, "tools"));
  const mcps = formatMcps(getRecord(data, "mcps"));
  const projectRoot = getString(data, "projectRoot");

  if (sessionId) {
    rows.push(row("Session", sessionId));
  }
  if (model) {
    rows.push(row("Model", model));
  }
  rows.push(row("Context", formatContextWindow(data)));
  if (tools) {
    rows.push(row("Tools", tools));
  }
  if (mcps) {
    rows.push(row("MCP", mcps));
  }
  if (projectRoot) {
    rows.push(row("Project", projectRoot));
  }

  return ["╭─ Status ─", ...rows, "╰──────────"].join("\n");
}

function row(label: string, value: string): string {
  return `│ ${label.padEnd(LABEL_WIDTH, " ")} ${value}`;
}

function formatContextWindow(data: Record<string, unknown>): string {
  const usage = toContextWindowUsage(getRecord(data, "contextWindow"));
  const formatted = formatContextWindowUsage(usage);
  return formatted === "" ? "Context unavailable" : formatted;
}

function toContextWindowUsage(
  record: Record<string, unknown> | undefined,
): UiContextWindowUsage | null {
  if (!record) {
    return null;
  }
  const currentTokens = getNumber(record, "currentTokens");
  const contextWindowTokens = getNumber(record, "contextWindowTokens");
  const contextWindowRatio = getNumber(record, "contextWindowRatio");
  if (
    currentTokens === undefined ||
    contextWindowTokens === undefined ||
    contextWindowRatio === undefined
  ) {
    return null;
  }

  return {
    contextWindowRatio,
    contextWindowTokens,
    currentTokens,
    estimatedAt: getString(record, "estimatedAt") ?? "",
    modelId: getString(record, "modelId") ?? "",
    sessionId: getString(record, "sessionId") ?? "",
  };
}

function formatModelLabel(
  model: Record<string, unknown> | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  return getString(model, "label") ?? getString(model, "id");
}

function formatTools(tools: Record<string, unknown> | undefined): string | null {
  if (!tools) {
    return null;
  }

  return `${formatCount(getNumber(tools, "builtin"))} builtin, ${formatCount(
    getNumber(tools, "module"),
  )} module, ${formatCount(getNumber(tools, "skill"))} skill, ${formatCount(
    getNumber(tools, "mcp"),
  )} mcp`;
}

function formatMcps(mcps: Record<string, unknown> | undefined): string | null {
  if (!mcps) {
    return null;
  }
  const entries: readonly CountLabel[] = [
    { count: getNumber(mcps, "connected"), label: "connected" },
    { count: getNumber(mcps, "failed"), label: "failed" },
    { count: getNumber(mcps, "disabled"), label: "disabled" },
    { count: getNumber(mcps, "disconnected"), label: "disconnected" },
  ]
    .filter((entry): entry is PresentCountLabel => entry.count !== undefined)
    .filter((entry) => entry.count > 0);
  const parts = entries.map(
    (entry) => `${formatCount(entry.count)} ${entry.label}`,
  );

  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatCount(value: number | undefined): string {
  return String(Math.max(0, Math.round(value ?? 0)));
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
