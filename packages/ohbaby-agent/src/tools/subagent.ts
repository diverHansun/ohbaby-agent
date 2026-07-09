import type {
  SessionSubagentHost,
  SubagentCloseResult,
  SubagentRunMode,
  SubagentRunResult,
  SubagentStatusResult,
} from "../agents/index.js";
import { DEFAULT_SUBAGENT_ROLE, SUBAGENT_ROLES } from "../agents/roles.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getOptionalNonEmptyStringParam,
  getRequiredNonEmptyStringParam,
  ToolParameterError,
} from "./utils/params.js";
import { subagentRoleParam } from "./utils/subagent-role.js";

export type SubagentToolHost = Pick<
  SessionSubagentHost,
  "close" | "run" | "status"
>;

function optionalBoolean(
  params: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a boolean when provided.`,
    );
  }
  return value;
}

function optionalPositiveInteger(
  params: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a positive integer when provided.`,
    );
  }
  return value;
}

function runMode(params: Record<string, unknown>): SubagentRunMode {
  const value = params.mode;
  if (value === undefined) {
    return "foreground";
  }
  if (value === "foreground" || value === "background") {
    return value;
  }
  throw new ToolParameterError(
    'Expected parameter "mode" to be "foreground" or "background".',
  );
}

function renderRun(result: SubagentRunResult): string {
  return [
    `subagent_id: ${result.item.subagentId}`,
    `session_id: ${result.item.sessionId}`,
    `context_scope_id: ${result.item.contextScopeId}`,
    `status: ${result.item.status}`,
    result.output
      ? `<subagent_output>\n${result.output}\n</subagent_output>`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

function renderStatus(result: SubagentStatusResult): string {
  if (result.items.length === 0) {
    return "No subagents found.";
  }
  return result.items
    .map((item) =>
      [
        `subagent_id: ${item.subagentId}`,
        `session_id: ${item.sessionId}`,
        `context_scope_id: ${item.contextScopeId}`,
        `status: ${item.status}`,
        item.output
          ? `<subagent_output>\n${item.output}\n</subagent_output>`
          : undefined,
        item.error
          ? `<subagent_error>\n${item.error}\n</subagent_error>`
          : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n"),
    )
    .join("\n\n");
}

function renderClose(result: SubagentCloseResult): string {
  return [
    `previous_status: ${result.previousStatus}`,
    `subagent_id: ${result.item.subagentId}`,
    `status: ${result.item.status}`,
  ].join("\n");
}

export function createSubagentTools(host: SubagentToolHost): readonly Tool[] {
  const run: Tool = {
    category: "subagent",
    description:
      "Create or continue a subagent. Use mode foreground to wait for the result, or background to return a subagent_id immediately. Use subagent_id with prompt to continue an existing subagent.",
    name: "subagent_run",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        role: {
          default: DEFAULT_SUBAGENT_ROLE,
          enum: [...SUBAGENT_ROLES],
          type: "string",
        },
        name: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
        mode: {
          default: "foreground",
          enum: ["foreground", "background"],
          type: "string",
        },
        subagent_id: { type: "string" },
        interrupt: { type: "boolean" },
        timeout_ms: { minimum: 1, type: "integer" },
      },
      required: ["prompt"],
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const subagentId = getOptionalNonEmptyStringParam(params, "subagent_id");
      const timeoutMs = optionalPositiveInteger(params, "timeout_ms");
      const result = await host.run({
        description: getOptionalNonEmptyStringParam(params, "description"),
        environment: context.environment,
        interrupt: optionalBoolean(params, "interrupt"),
        mode: runMode(params),
        name: getOptionalNonEmptyStringParam(params, "name"),
        parentSessionId: context.sessionId,
        prompt: getRequiredNonEmptyStringParam(params, "prompt"),
        role: subagentId === undefined ? subagentRoleParam(params) : undefined,
        signal: context.signal,
        subagentId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return {
        metadata: { subagent: result },
        output: renderRun(result),
      };
    },
  };

  const status: Tool = {
    annotations: { readOnlyHint: true },
    category: "subagent",
    description:
      "List subagent statuses for this parent session, or inspect one subagent_id.",
    name: "subagent_status",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        subagent_id: { type: "string" },
      },
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const result = await host.status({
        parentSessionId: context.sessionId,
        subagentId: getOptionalNonEmptyStringParam(params, "subagent_id"),
      });
      return {
        metadata: { subagentStatus: result },
        output: renderStatus(result),
      };
    },
  };

  const close: Tool = {
    category: "subagent",
    description: "Close or cancel a subagent by subagent_id.",
    name: "subagent_close",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        subagent_id: { type: "string" },
      },
      required: ["subagent_id"],
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const result = await host.close({
        parentSessionId: context.sessionId,
        subagentId: getRequiredNonEmptyStringParam(params, "subagent_id"),
      });
      return {
        metadata: { subagentClose: result },
        output: renderClose(result),
      };
    },
  };

  return [run, status, close];
}
