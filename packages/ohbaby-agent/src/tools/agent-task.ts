import type {
  AgentTaskController,
  AgentTaskRecord,
} from "../agents/index.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { ToolParameterError } from "./utils/params.js";

export const AGENT_TASK_TOOL_NAMES = [
  "agent_open",
  "agent_eval",
  "agent_status",
  "agent_close",
] as const;

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a non-empty string.`,
    );
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a non-empty string when provided.`,
    );
  }
  return value;
}

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
      "Start a background subagent task in an isolated child session and return immediately with a task id.",
    name: "agent_open",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        agent_name: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["agent_name", "prompt"],
      type: "object",
    },
    source: "builtin",
    async execute(
      params: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const task = await controller.open({
        agentName: requiredString(params, "agent_name"),
        description: optionalString(params, "description"),
        environment: context.environment,
        parentSessionId: context.sessionId,
        prompt: requiredString(params, "prompt"),
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
        prompt: requiredString(params, "prompt"),
        taskId: requiredString(params, "task_id"),
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
      const taskId = requiredString(params, "task_id");
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
        taskId: requiredString(params, "task_id"),
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
