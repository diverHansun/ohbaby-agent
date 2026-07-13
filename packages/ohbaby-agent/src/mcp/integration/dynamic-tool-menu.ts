import { scanPromptLikeContent } from "../../core/system-prompt/security/index.js";
import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../core/tool-scheduler/index.js";

export const MAX_MCP_TOOL_DESCRIPTION_CHARS = 2_048;
export const MAX_MCP_TOOL_NAME_CHARS = 256;
export const MAX_MCP_TOOL_SCHEMA_CHARS = 32_768;
export const MAX_MCP_TOOL_SCHEMA_DEPTH = 64;
export const MAX_MCP_TOOLS_PER_SELECTION = 8;
export const MAX_MCP_TOOLS_PER_SESSION = 8;

const FIXED_MCP_TOOL_DESCRIPTION =
  "MCP tool loaded on demand. Use its schema to perform the requested operation.";
const SELECT_TOOLS_DESCRIPTION =
  "Load up to 8 exact MCP tool names for this session/context scope.";
const SAFE_LOCAL_MCP_TOOL_NAME = /^mcp_[A-Za-z0-9_-]+$/u;

export type McpToolRejectionReason =
  | "description-too-large"
  | "invalid-name"
  | "name-too-large"
  | "invalid-schema"
  | "schema-too-large"
  | "unsafe-description"
  | "unsafe-schema";

export interface McpToolRejection {
  readonly name: string;
  readonly reason: McpToolRejectionReason;
}

export interface McpToolAdmissionResult {
  readonly accepted: readonly Tool[];
  readonly rejected: readonly McpToolRejection[];
}

export interface McpToolMenuScope {
  readonly sessionId: string;
  readonly contextScopeId?: string;
}

export interface McpToolSelection {
  readonly alreadyLoaded: readonly string[];
  readonly limitReached: readonly string[];
  readonly loaded: readonly string[];
  readonly unknown: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(
  value: unknown,
  visited = new WeakSet<object>(),
  depth = 0,
): boolean {
  if (depth > MAX_MCP_TOOL_SCHEMA_DEPTH) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, visited, depth + 1));
  }
  if (!isPlainRecord(value) || visited.has(value)) {
    return false;
  }
  visited.add(value);
  return Object.values(value).every((item) =>
    isJsonValue(item, visited, depth + 1),
  );
}

function schemaJson(schema: Record<string, unknown>): string | undefined {
  try {
    if (!isJsonValue(schema)) {
      return undefined;
    }
    return JSON.stringify(schema);
  } catch {
    return undefined;
  }
}

function safeToolName(name: string): string {
  return SAFE_LOCAL_MCP_TOOL_NAME.test(name) &&
    name.length <= MAX_MCP_TOOL_NAME_CHARS
    ? name
    : "invalid-mcp-tool";
}

function reject(
  tool: Tool,
  reason: McpToolRejectionReason,
): McpToolAdmissionResult {
  return {
    accepted: [],
    rejected: [{ name: safeToolName(tool.name), reason }],
  };
}

function admitMcpToolUnchecked(tool: Tool): McpToolAdmissionResult {
  if (!SAFE_LOCAL_MCP_TOOL_NAME.test(tool.name)) {
    return reject(tool, "invalid-name");
  }
  if (tool.name.length > MAX_MCP_TOOL_NAME_CHARS) {
    return reject(tool, "name-too-large");
  }
  if (tool.description.length > MAX_MCP_TOOL_DESCRIPTION_CHARS) {
    return reject(tool, "description-too-large");
  }
  if (
    scanPromptLikeContent(tool.description, {
      kind: "tool-description",
      label: `MCP tool ${tool.name}`,
    }).findings.length > 0
  ) {
    return reject(tool, "unsafe-description");
  }
  if (!isPlainRecord(tool.parametersJsonSchema)) {
    return reject(tool, "invalid-schema");
  }
  const serializedSchema = schemaJson(tool.parametersJsonSchema);
  if (serializedSchema === undefined) {
    return reject(tool, "invalid-schema");
  }
  if (serializedSchema.length > MAX_MCP_TOOL_SCHEMA_CHARS) {
    return reject(tool, "schema-too-large");
  }
  if (
    scanPromptLikeContent(serializedSchema, {
      kind: "tool-description",
      label: `MCP tool schema ${tool.name}`,
    }).findings.length > 0
  ) {
    return reject(tool, "unsafe-schema");
  }

  return {
    accepted: [
      {
        ...tool,
        category:
          tool.isTrusted === true && tool.annotations?.readOnlyHint === true
            ? "readonly"
            : "write",
        description: FIXED_MCP_TOOL_DESCRIPTION,
        requireExplicitApproval:
          tool.isTrusted !== true || tool.requireExplicitApproval === true,
      },
    ],
    rejected: [],
  };
}

export function admitMcpTool(tool: Tool): McpToolAdmissionResult {
  try {
    return admitMcpToolUnchecked(tool);
  } catch {
    return reject(tool, "invalid-schema");
  }
}

export function admitMcpTools(tools: readonly Tool[]): McpToolAdmissionResult {
  const accepted: Tool[] = [];
  const rejected: McpToolRejection[] = [];
  for (const tool of tools) {
    const result = admitMcpTool(tool);
    accepted.push(...result.accepted);
    rejected.push(...result.rejected);
  }
  return { accepted, rejected };
}

function scopeKey(scope: McpToolMenuScope): string {
  return `${scope.sessionId}\u0000${scope.contextScopeId ?? ""}`;
}

function uniqueNames(value: readonly string[]): string[] {
  return [...new Set(value.filter((name) => name.trim() !== ""))];
}

export class McpToolMenu {
  private available = new Set<string>();
  private readonly loadedByScope = new Map<string, Set<string>>();

  setAvailable(names: readonly string[]): void {
    this.available = new Set(uniqueNames(names));
    for (const loaded of this.loadedByScope.values()) {
      for (const name of loaded) {
        if (!this.available.has(name)) {
          loaded.delete(name);
        }
      }
    }
  }

  selectableNames(candidates?: readonly ToolDefinition[]): string[] {
    const candidateNames = candidates
      ? new Set(
          candidates
            .filter((tool) => tool.source === "mcp")
            .map((tool) => tool.name),
        )
      : undefined;
    return [...this.available]
      .filter((name) => candidateNames?.has(name) ?? true)
      .sort((left, right) => left.localeCompare(right));
  }

  loadedNames(
    scope: McpToolMenuScope,
    candidates?: readonly ToolDefinition[],
  ): ReadonlySet<string> {
    const loaded = this.loadedByScope.get(scopeKey(scope)) ?? new Set<string>();
    const candidateNames = candidates
      ? new Set(candidates.map((tool) => tool.name))
      : undefined;
    return new Set(
      [...loaded].filter(
        (name) =>
          this.available.has(name) && (candidateNames?.has(name) ?? true),
      ),
    );
  }

  select(scope: McpToolMenuScope, names: readonly string[]): McpToolSelection {
    const loaded = this.loadedByScope.get(scopeKey(scope)) ?? new Set<string>();
    this.loadedByScope.set(scopeKey(scope), loaded);
    const alreadyLoaded: string[] = [];
    const limitReached: string[] = [];
    const newlyLoaded: string[] = [];
    const unknown: string[] = [];
    for (const name of uniqueNames(names)) {
      if (!this.available.has(name)) {
        unknown.push(name);
      } else if (loaded.has(name)) {
        alreadyLoaded.push(name);
      } else if (loaded.size >= MAX_MCP_TOOLS_PER_SESSION) {
        limitReached.push(name);
      } else {
        loaded.add(name);
        newlyLoaded.push(name);
      }
    }
    return { alreadyLoaded, limitReached, loaded: newlyLoaded, unknown };
  }

  disposeSession(sessionId: string): void {
    for (const key of this.loadedByScope.keys()) {
      if (
        key === `${sessionId}\u0000` ||
        key.startsWith(`${sessionId}\u0000`)
      ) {
        this.loadedByScope.delete(key);
      }
    }
  }
}

function requestedToolNames(params: Record<string, unknown>): string[] {
  const value = params.tools;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("select_tools requires at least one MCP tool name.");
  }
  if (value.length > MAX_MCP_TOOLS_PER_SELECTION) {
    throw new Error(
      `select_tools accepts at most ${String(MAX_MCP_TOOLS_PER_SELECTION)} MCP tools.`,
    );
  }
  if (value.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new Error("select_tools accepts only non-empty MCP tool names.");
  }
  return value as string[];
}

function selectionOutput(selection: McpToolSelection): string {
  const lines: string[] = [];
  if (selection.loaded.length > 0) {
    lines.push(`Loaded MCP tools: ${selection.loaded.join(", ")}.`);
  }
  if (selection.alreadyLoaded.length > 0) {
    lines.push(`Already loaded: ${selection.alreadyLoaded.join(", ")}.`);
  }
  if (selection.limitReached.length > 0) {
    lines.push(
      `Session/context scope tool limit reached: ${selection.limitReached.join(", ")}.`,
    );
  }
  if (selection.unknown.length > 0) {
    lines.push(`Unavailable MCP tools: ${selection.unknown.join(", ")}.`);
  }
  return lines.join("\n") || "No MCP tools were loaded.";
}

export function createSelectToolsTool(menu: McpToolMenu): Tool {
  return {
    annotations: { readOnlyHint: true },
    category: "readonly",
    description: SELECT_TOOLS_DESCRIPTION,
    name: "select_tools",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        tools: {
          items: { type: "string" },
          maxItems: MAX_MCP_TOOLS_PER_SELECTION,
          minItems: 1,
          type: "array",
        },
      },
      required: ["tools"],
      type: "object",
    },
    source: "builtin",
    execute(
      params: Record<string, unknown>,
      context: ToolExecutionContext,
    ): ToolExecutionResult {
      const selection = menu.select(
        {
          contextScopeId: context.contextScopeId,
          sessionId: context.sessionId,
        },
        requestedToolNames(params),
      );
      return { output: selectionOutput(selection) };
    },
  };
}
