import {
  withToolAdmission,
  independentToolAdmission,
  trustedToolAdmission,
} from "../../core/tool-scheduler/tool-admission.js";
import { scanPromptLikeContent } from "../../core/system-prompt/security/index.js";
import type {
  MessageScopeFilter,
  MessageWithParts,
} from "../../core/message/types.js";
import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../core/tool-scheduler/index.js";
import {
  McpToolSearch,
  type McpToolSearchDocument,
  type McpToolSearchResult,
} from "./mcp-tool-search.js";

export const MAX_MCP_TOOL_DESCRIPTION_CHARS = 2_048;
export const MAX_MCP_TOOL_NAME_CHARS = 256;
export const MAX_MCP_TOOL_SCHEMA_CHARS = 32_768;
export const MAX_MCP_TOOL_SCHEMA_DEPTH = 64;
export const MAX_MCP_TOOLS_PER_SELECTION = 8;

const FIXED_MCP_TOOL_DESCRIPTION =
  "MCP tool loaded on demand. Use its schema to perform the requested operation.";
const SELECT_TOOLS_DESCRIPTION =
  "Load exact MCP tool names, or search available MCP tools by query. Search does not load unless load is true.";
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
  readonly loaded: readonly string[];
  readonly unknown: readonly string[];
}

/** Read-only history source the menu rebuilds loaded tool names from. */
export interface McpToolMenuHistory {
  listBySession(
    sessionId: string,
    filter?: MessageScopeFilter,
  ): Promise<MessageWithParts[]>;
}

export interface McpToolMenuOptions {
  /** Omitted means the history is empty (unit tests, ephemeral menus). */
  readonly history?: McpToolMenuHistory;
  readonly onError?: (error: unknown) => void;
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

  const admitted: Tool = {
    ...tool,
    category:
      tool.isTrusted === true && tool.annotations?.readOnlyHint === true
        ? "readonly"
        : "write",
    description: FIXED_MCP_TOOL_DESCRIPTION,
    requireExplicitApproval:
      tool.isTrusted !== true || tool.requireExplicitApproval === true,
  };
  // Sanitization copies the implementation object; preserve only this trusted
  // cancellation fact capability, never claims in serialized tool metadata.
  if (trustedToolAdmission(tool)?.settlementConfirmsCleanup === false)
    withToolAdmission(admitted, { settlementConfirmsCleanup: false });
  return {
    accepted: [admitted],
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

/**
 * Loaded MCP tool names recorded in history, in first-loaded order.
 *
 * Only completed `select_tools` parts count, and only their
 * `state.metadata.mcpSelection.loaded` names. Compacted parts still count so
 * the tool list survives compaction. This shape is a persisted contract: older
 * rows may also carry `limitReached`, which is ignored.
 */
export function collectLoadedMcpToolNames(
  messages: readonly MessageWithParts[],
): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type !== "tool" ||
        part.tool !== "select_tools" ||
        part.state.status !== "completed"
      ) {
        continue;
      }
      const selection = part.state.metadata?.mcpSelection;
      if (!isPlainRecord(selection) || !Array.isArray(selection.loaded)) {
        continue;
      }
      for (const name of selection.loaded) {
        if (typeof name === "string" && name.trim() !== "") {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}

/**
 * Per-scope loaded MCP tool names. History is the source of truth; the map
 * below only caches what `collectLoadedMcpToolNames` derives from it, plus
 * names selected since. Names are never removed when a tool becomes
 * unavailable: reads intersect them with the currently available tools.
 */
export class McpToolMenu {
  private available = new Set<string>();
  private readonly loadedByScope = new Map<string, Set<string>>();
  /** In-flight history reads; the entry object identifies one read. */
  private readonly loadingByScope = new Map<
    string,
    { promise: Promise<void> }
  >();
  private searchIndex = new McpToolSearch([]);

  constructor(private readonly options: McpToolMenuOptions = {}) {}

  setAvailable(
    names: readonly string[],
    searchDocuments: readonly McpToolSearchDocument[] = [],
  ): void {
    this.available = new Set(uniqueNames(names));
    this.searchIndex = new McpToolSearch(
      searchDocuments.filter((document) =>
        this.available.has(document.localName),
      ),
    );
  }

  search(query: string, limit: number): McpToolSearchResult[] {
    return this.searchIndex.search(query, limit);
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

  /**
   * Rebuilds the scope's names from history once, then serves the cache.
   * Concurrent callers share one read. A history error is reported and leaves
   * the scope uncached so the next call retries.
   */
  ensureLoaded(scope: McpToolMenuScope): Promise<void> {
    const key = scopeKey(scope);
    if (this.loadedByScope.has(key)) {
      return Promise.resolve();
    }
    const existing = this.loadingByScope.get(key);
    if (existing !== undefined) {
      return existing.promise;
    }
    // Register the entry before the read starts so the read can tell whether
    // a dispose replaced it while it was waiting.
    const entry = { promise: Promise.resolve() };
    this.loadingByScope.set(key, entry);
    entry.promise = this.loadFromHistory(scope, key, entry);
    return entry.promise;
  }

  /** Call `ensureLoaded` first; an unloaded scope reads as empty. */
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

  async select(
    scope: McpToolMenuScope,
    names: readonly string[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<McpToolSelection> {
    await this.ensureLoaded(scope);
    if (options.signal?.aborted === true) {
      throw new Error("select_tools was aborted before loading MCP tools.");
    }
    // Everything below is synchronous, so concurrent selects never interleave.
    const loaded = this.loadedByScope.get(scopeKey(scope));
    if (loaded === undefined) {
      throw new Error(
        "MCP tools cannot be loaded for this context scope: it was released or its history could not be read.",
      );
    }
    const alreadyLoaded: string[] = [];
    const newlyLoaded: string[] = [];
    const unknown: string[] = [];
    for (const name of uniqueNames(names)) {
      if (!this.available.has(name)) {
        unknown.push(name);
      } else if (loaded.has(name)) {
        alreadyLoaded.push(name);
      } else {
        loaded.add(name);
        newlyLoaded.push(name);
      }
    }
    return { alreadyLoaded, loaded: newlyLoaded, unknown };
  }

  disposeSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const map of [this.loadedByScope, this.loadingByScope]) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) {
          map.delete(key);
        }
      }
    }
  }

  disposeScope(sessionId: string, contextScopeId: string): void {
    const key = scopeKey({ sessionId, contextScopeId });
    this.loadedByScope.delete(key);
    this.loadingByScope.delete(key);
  }

  private async loadFromHistory(
    scope: McpToolMenuScope,
    key: string,
    entry: { promise: Promise<void> },
  ): Promise<void> {
    let names: string[] | undefined;
    try {
      // The filter object is required: omitting it reads every scope.
      names = this.options.history
        ? collectLoadedMcpToolNames(
            await this.options.history.listBySession(scope.sessionId, {
              contextScopeId: scope.contextScopeId,
            }),
          )
        : [];
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // A failing reporter must not leave this read stuck in loadingByScope.
      }
    }
    // A dispose (or a newer read after it) during this read wins: drop the result.
    if (this.loadingByScope.get(key) !== entry) {
      return;
    }
    this.loadingByScope.delete(key);
    if (names !== undefined && !this.loadedByScope.has(key)) {
      this.loadedByScope.set(key, new Set(names));
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

const DEFAULT_MCP_TOOL_SEARCH_LIMIT = 5;

type SelectToolsRequest =
  | { readonly kind: "exact"; readonly tools: readonly string[] }
  | {
      readonly kind: "query";
      readonly limit: number;
      readonly load: boolean;
      readonly query: string;
    };

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function selectToolsRequest(
  params: Record<string, unknown>,
): SelectToolsRequest {
  const hasTools = hasOwn(params, "tools");
  const hasQuery = hasOwn(params, "query");
  const hasLoad = hasOwn(params, "load");
  const hasLimit = hasOwn(params, "limit");
  if (hasTools) {
    if (hasQuery || hasLoad || hasLimit) {
      throw new Error(
        "select_tools tools cannot be combined with query, load, or limit.",
      );
    }
    return { kind: "exact", tools: requestedToolNames(params) };
  }
  if (!hasQuery) {
    throw new Error("select_tools requires either tools or a query.");
  }
  if (typeof params.query !== "string" || params.query.trim() === "") {
    throw new Error("select_tools query must be a non-empty string.");
  }
  if (hasLoad && typeof params.load !== "boolean") {
    throw new Error("select_tools load must be a boolean.");
  }
  const limit = params.limit ?? DEFAULT_MCP_TOOL_SEARCH_LIMIT;
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_MCP_TOOLS_PER_SELECTION
  ) {
    throw new Error(
      `select_tools limit must be an integer from 1 to ${String(MAX_MCP_TOOLS_PER_SELECTION)}.`,
    );
  }
  return {
    kind: "query",
    limit: limit as number,
    load: params.load === true,
    query: params.query.trim(),
  };
}

function emptySelection(): McpToolSelection {
  return { alreadyLoaded: [], loaded: [], unknown: [] };
}

function selectionOutput(selection: McpToolSelection): string {
  const lines: string[] = [];
  if (selection.loaded.length > 0) {
    lines.push(`Loaded MCP tools: ${selection.loaded.join(", ")}.`);
  }
  if (selection.alreadyLoaded.length > 0) {
    lines.push(`Already loaded: ${selection.alreadyLoaded.join(", ")}.`);
  }
  if (selection.unknown.length > 0) {
    lines.push(`Unavailable MCP tools: ${selection.unknown.join(", ")}.`);
  }
  return lines.join("\n") || "No MCP tools were loaded.";
}

export function createSelectToolsTool(menu: McpToolMenu): Tool {
  return withToolAdmission(
    {
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
          query: { minLength: 1, type: "string" },
          limit: {
            maximum: MAX_MCP_TOOLS_PER_SELECTION,
            minimum: 1,
            type: "integer",
          },
          load: { type: "boolean" },
        },
        type: "object",
      },
      source: "builtin",
      async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> {
        const request = selectToolsRequest(params);
        const scope = {
          contextScopeId: context.contextScopeId,
          sessionId: context.sessionId,
        };
        const candidates =
          request.kind === "query"
            ? menu.search(request.query, request.limit)
            : [];
        // select checks the signal after its history read and before it
        // changes the cache, so an aborted call never loads tools.
        const selectOptions = { signal: context.signal };
        const selection =
          request.kind === "exact"
            ? await menu.select(scope, request.tools, selectOptions)
            : request.load
              ? await menu.select(
                  scope,
                  candidates.map((candidate) => candidate.name),
                  selectOptions,
                )
              : emptySelection();
        const candidateOutput =
          request.kind !== "query"
            ? ""
            : candidates.length === 0
              ? "No matching MCP tools found."
              : `MCP tool candidates: ${candidates
                  .map(
                    (candidate) =>
                      `${candidate.name} (${candidate.score.toFixed(4)})`,
                  )
                  .join(", ")}.`;
        const selectionSummary =
          request.kind === "exact" || request.load
            ? selectionOutput(selection)
            : "";
        const output = [candidateOutput, selectionSummary]
          .filter((line) => line !== "")
          .join("\n");
        return {
          metadata: {
            mcpSelection: { candidates, ...selection },
          },
          output,
        };
      },
    },
    independentToolAdmission,
  );
}
