import type { AgentTaskController, AgentTaskRecord } from "../agents/index.js";
import { DEFAULT_SUBAGENT_ROLE, SUBAGENT_ROLES } from "../agents/roles.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getOptionalNonEmptyStringParam,
  getRequiredNonEmptyStringParam,
  ToolParameterError,
} from "./utils/params.js";
import { subagentRoleParam } from "./utils/subagent-role.js";

export const AGENT_TASK_TOOL_NAMES = [
  "agent_open",
  "agent_eval",
  "agent_status",
  "agent_close",
] as const;

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

function renderTask(task: AgentTaskRecord): string {
  return [
    `task_id: ${task.taskId}`,
    `session_id: ${task.sessionId}`,
    `status: ${task.status}`,
    `pending_inputs: ${String(task.pendingInputCount)}`,
    task.timeoutMs ? `timeout_ms: ${String(task.timeoutMs)}` : undefined,
    task.output ? `<task_output>\n${task.output}\n</task_output>` : undefined,
    task.error ? `<task_error>\n${task.error}\n</task_error>` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

function result(task: AgentTaskRecord): ToolExecutionResult {
  return {
    metadata: { agentTask: task },
    output: renderTask(task),
  };
}

function notFound(taskId: string): ToolExecutionResult {
  return {
    metadata: { agentTask: null, taskId },
    output: `Agent task not found: ${taskId}`,
  };
}

export function createAgentTaskTools(
  controller: AgentTaskController,
): readonly Tool[] {
  const open: Tool = {
    category: "subagent",
    description:
      "Start a longer-running, asynchronous background subagent task (writing/editing code, running tests, multi-step investigations). Returns a task_id immediately so you stay in control; follow up with agent_status (poll), agent_eval (send input), or agent_close (cancel). Role is optional and defaults to generic. Allowed roles are generic, explore, research. Use name/description for UI metadata only; put behavioral instructions in prompt.",
    name: "agent_open",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        role: {
          default: DEFAULT_SUBAGENT_ROLE,
          description:
            "Optional subagent behavior role. Allowed: generic, explore, research. Omit for generic.",
          enum: [...SUBAGENT_ROLES],
          type: "string",
        },
        name: {
          description:
            "Optional display name for this subagent instance. Metadata only.",
          type: "string",
        },
        description: {
          description:
            "Optional UI/log description. Metadata only; include behavioral instructions in prompt.",
          type: "string",
        },
        prompt: { type: "string" },
      },
      required: ["prompt"],
      type: "object",
    },
    source: "builtin",
    async execute(
      params: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const task = await controller.open({
        role: subagentRoleParam(params),
        name: getOptionalNonEmptyStringParam(params, "name"),
        description: getOptionalNonEmptyStringParam(params, "description"),
        environment: context.environment,
        parentSessionId: context.sessionId,
        prompt: getRequiredNonEmptyStringParam(params, "prompt"),
        signal: context.signal,
      });
      return result(task);
    },
  };

  const evaluate: Tool = {
    category: "subagent",
    description:
      "Send follow-up input to a background subagent task. Running tasks queue input unless interrupt is true.",
    name: "agent_eval",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        interrupt: { type: "boolean" },
        prompt: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["task_id", "prompt"],
      type: "object",
    },
    source: "builtin",
    async execute(
      params: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const task = await controller.sendInput({
        environment: context.environment,
        interrupt: optionalBoolean(params, "interrupt"),
        parentSessionId: context.sessionId,
        prompt: getRequiredNonEmptyStringParam(params, "prompt"),
        taskId: getRequiredNonEmptyStringParam(params, "task_id"),
      });
      return result(task);
    },
  };

  const status: Tool = {
    annotations: { readOnlyHint: true },
    category: "subagent",
    description:
      "Inspect a background subagent task status, pending input count, and latest output.",
    name: "agent_status",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const taskId = getRequiredNonEmptyStringParam(params, "task_id");
      const task = await controller.get({
        parentSessionId: context.sessionId,
        taskId,
      });
      return task ? result(task) : notFound(taskId);
    },
  };

  const close: Tool = {
    category: "subagent",
    description:
      "Close a background subagent task, cancelling the active child run if one is running.",
    name: "agent_close",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const closed = await controller.close({
        parentSessionId: context.sessionId,
        taskId: getRequiredNonEmptyStringParam(params, "task_id"),
      });
      return {
        metadata: {
          agentTask: closed.task,
          previousStatus: closed.previousStatus,
        },
        output: [
          `previous_status: ${closed.previousStatus}`,
          renderTask(closed.task),
        ].join("\n"),
      };
    },
  };

  return [open, evaluate, status, close];
}
