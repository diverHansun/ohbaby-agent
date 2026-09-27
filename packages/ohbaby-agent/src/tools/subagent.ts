import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
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

function executionSummary(
  record: SubagentRunResult["execution"],
): Record<string, unknown> {
  return {
    executionId: record.executionId,
    subagentId: record.subagentId,
    childSessionId: record.childSessionId,
    childScopeId: record.childScopeId,
    childRunId: record.childRunId,
    status: record.status,
    reason: record.reason?.slice(0, 512),
    mode: record.mode,
    resultStored: record.completedAt !== undefined,
    sizeBytes: Buffer.byteLength(record.output ?? "", "utf8"),
  };
}

function renderRun(result: SubagentRunResult): string {
  const execution = result.execution;
  if (execution.mode === "background")
    return [
      `execution_id: ${execution.executionId}`,
      `subagent_id: ${execution.subagentId}`,
      "accepted: true",
      `status: ${execution.childRunId ? "running" : "queued"}`,
    ].join("\n");
  return [
    `execution_id: ${execution.executionId}`,
    `subagent_id: ${execution.subagentId}`,
    execution.childSessionId
      ? `session_id: ${execution.childSessionId}`
      : undefined,
    execution.childScopeId
      ? `context_scope_id: ${execution.childScopeId}`
      : undefined,
    `status: ${result.paused ? "paused" : execution.status}`,
    result.item?.pendingQueue.length
      ? `pending_inputs: ${String(result.item.pendingQueue.length)}`
      : undefined,
    execution.reason ? `terminal_reason: ${execution.reason}` : undefined,
    result.paused
      ? "program_note: Input remains queued and has not run."
      : undefined,
    result.success && result.output
      ? `<subagent_output>\n${result.output}\n</subagent_output>`
      : undefined,
    result.success && !result.output ? "program_note: No output." : undefined,
    !result.success && result.output
      ? `<subagent_error>\n${result.output}\n</subagent_error>`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

function statusSummary(result: SubagentStatusResult): Record<string, unknown> {
  return {
    items: result.items.slice(0, 20).map((item) => ({
      subagentId: item.subagentId,
      sessionId: item.sessionId,
      contextScopeId: item.contextScopeId,
      role: item.role,
      status: item.status,
      currentRunId: item.currentRunId,
      lastRunId: item.lastRunId,
      pendingInputs: item.pendingQueue.length,
    })),
    executions: result.executions.map(executionSummary),
  };
}

function renderStatus(result: SubagentStatusResult): string {
  if (result.items.length === 0 && result.executions.length === 0)
    return "No subagents found.";
  return JSON.stringify(statusSummary(result));
}

function renderClose(result: SubagentCloseResult): string {
  return [
    `previous_status: ${result.previousStatus}`,
    `subagent_id: ${result.subagentId}`,
    `status: ${result.item?.status ?? "cancelled"}`,
    ...(result.reason
      ? [`<subagent_error>\n${result.reason}\n</subagent_error>`]
      : []),
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
        timeout_ms: { maximum: 1_800_000, minimum: 1, type: "integer" },
      },
      required: ["prompt"],
      type: "object",
    },
    source: "builtin",
    timeoutOwner: "tool",
    async execute(params, context): Promise<ToolExecutionResult> {
      if (!context.runId?.trim())
        throw new ToolParameterError(
          "subagent_run requires a real requester run identity.",
        );
      const subagentId = getOptionalNonEmptyStringParam(params, "subagent_id");
      const timeoutMs = optionalPositiveInteger(params, "timeout_ms");
      if (timeoutMs !== undefined && timeoutMs > 1_800_000)
        throw new ToolParameterError(
          "subagent timeout_ms must not exceed 1800000ms",
        );
      const result = await host.run({
        requesterRunId: context.runId,
        requesterMessageId: context.messageId,
        requestId: context.callId,
        description: getOptionalNonEmptyStringParam(params, "description"),
        environment: context.environment,
        interrupt: optionalBoolean(params, "interrupt"),
        mode: runMode(params),
        name: getOptionalNonEmptyStringParam(params, "name"),
        parentSessionId: context.sessionId,
        ...(context.contextScopeId === undefined
          ? {}
          : { parentContextScopeId: context.contextScopeId }),
        prompt: getRequiredNonEmptyStringParam(params, "prompt"),
        role: subagentId === undefined ? subagentRoleParam(params) : undefined,
        signal: context.signal,
        subagentId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return {
        metadata: {
          subagent: {
            execution: executionSummary(result.execution),
            item: result.item
              ? {
                  subagentId: result.item.subagentId,
                  sessionId: result.item.sessionId,
                  contextScopeId: result.item.contextScopeId,
                  role: result.item.role,
                  name: result.item.name,
                  description: result.item.description,
                }
              : undefined,
            paused: result.paused,
            success: result.success,
          },
        },
        output: renderRun(result),
      };
    },
  };

  const status: Tool = {
    annotations: { readOnlyHint: true },
    category: "subagent-control",
    description:
      "List subagent statuses for this parent session, or inspect one subagent_id.",
    name: "subagent_status",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        subagent_id: { type: "string" },
        execution_id: { type: "string" },
      },
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const result = await host.status({
        executionId: getOptionalNonEmptyStringParam(params, "execution_id"),
        parentContextScopeId: context.contextScopeId,
        parentSessionId: context.sessionId,
        subagentId: getOptionalNonEmptyStringParam(params, "subagent_id"),
      });
      return {
        metadata: { subagentStatus: statusSummary(result) },
        output: renderStatus(result),
      };
    },
  };

  const close: Tool = {
    category: "subagent-control",
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

  return [
    withToolAdmission(run, { capacity: "dispatch", plan: () => [] }),
    withToolAdmission(status, { capacity: "control", plan: () => [] }),
    withToolAdmission(close, { capacity: "control", plan: () => [] }),
  ];
}
