import {
  MAX_SUBAGENT_EXECUTIONS,
  MAX_SUBAGENT_TIMEOUT_MS,
} from "../agents/subagents/limits.js";
import { renderExecutionFacts } from "../agents/subagents/execution-facts.js";
import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import type {
  SessionSubagentHost,
  SubagentRunResult,
  SubagentStatusResult,
} from "../agents/index.js";
import type { SubagentStartResult } from "../agents/subagents/types.js";
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
  "spawn" | "send" | "list" | "monitor" | "stop" | "close"
>;
const ACTIONS = ["spawn", "send", "list", "monitor", "stop", "close"] as const;
type Action = (typeof ACTIONS)[number];
const ACTION_FIELDS: Record<Action, readonly string[]> = {
  spawn: ["prompt", "name", "description", "role", "mode", "timeout_ms"],
  send: ["agent_id", "message", "mode"],
  list: [],
  monitor: ["agent_ids", "cursors"],
  stop: ["agent_id"],
  close: ["agent_id"],
};
function actionParam(params: Record<string, unknown>): Action {
  const value = params.action;
  if (typeof value !== "string" || !ACTIONS.includes(value as Action))
    throw new ToolParameterError(
      `Expected parameter "action" to be one of: ${ACTIONS.join(", ")}.`,
    );
  const action = value as Action;
  for (const field of Object.keys(params)) {
    if (field !== "action" && !ACTION_FIELDS[action].includes(field))
      throw new ToolParameterError(
        `Parameter "${field}" is not supported for agent action "${action}".`,
      );
  }
  return action;
}
function timeoutParam(params: Record<string, unknown>): number | undefined {
  const value = params.timeout_ms;
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SUBAGENT_TIMEOUT_MS
  )
    throw new ToolParameterError(
      'Expected parameter "timeout_ms" to be an integer between 1 and 1800000.',
    );
  return value;
}
/** Agents always run in the background (D54); an explicit "background" is tolerated. */
function assertBackgroundMode(params: Record<string, unknown>): void {
  if (params.mode === undefined || params.mode === "background") return;
  if (params.mode === "foreground")
    throw new ToolParameterError(
      'Foreground mode is not available: agents always run in the background and results arrive automatically. Omit "mode".',
    );
  throw new ToolParameterError('Expected parameter "mode" to be omitted.');
}
function monitorParams(params: Record<string, unknown>): {
  subagentIds: string[];
  cursors?: Record<string, string>;
} {
  if (
    !Array.isArray(params.agent_ids) ||
    params.agent_ids.length === 0 ||
    params.agent_ids.length > MAX_SUBAGENT_EXECUTIONS
  )
    throw new ToolParameterError(
      'Expected parameter "agent_ids" to contain 1 to 6 non-empty IDs.',
    );
  const subagentIds = params.agent_ids.map((value: unknown) => {
    if (typeof value !== "string" || !value.trim())
      throw new ToolParameterError(
        'Expected each "agent_ids" entry to be a non-empty string.',
      );
    return value.trim();
  });
  if (new Set(subagentIds).size !== subagentIds.length)
    throw new ToolParameterError('Expected unique IDs in "agent_ids".');
  if (params.cursors === undefined) return { subagentIds };
  if (
    typeof params.cursors !== "object" ||
    params.cursors === null ||
    Array.isArray(params.cursors)
  )
    throw new ToolParameterError(
      'Expected parameter "cursors" to be an object keyed by agent ID.',
    );
  const cursors: Record<string, string> = {};
  for (const [id, cursor] of Object.entries(params.cursors)) {
    if (
      !subagentIds.includes(id) ||
      typeof cursor !== "string" ||
      !cursor.trim()
    )
      throw new ToolParameterError(
        'Each "cursors" entry must contain a non-empty cursor for a requested agent ID.',
      );
    cursors[id] = cursor;
  }
  return { subagentIds, cursors };
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
    artifact: record.artifact,
    sizeBytes: Buffer.byteLength(record.output ?? "", "utf8"),
  };
}
function startResult(
  action: "spawn" | "send",
  result: SubagentStartResult,
): ToolExecutionResult {
  if (!result.execution)
    return {
      output: `started: false\nreason: ${result.reason}\nThis invocation did not start an execution. Do not retry immediately.`,
      metadata: { subagent: { action, started: false, reason: result.reason } },
    };
  const execution = result.execution;
  const receipt = [
    `agent_id: ${execution.subagentId}`,
    `execution_id: ${execution.executionId}`,
    `started: ${String(result.started)}`,
    `mode: ${execution.mode}`,
    `status: ${execution.status}`,
  ];
  if (!result.started)
    return {
      output: [
        ...receipt,
        "accepted: true",
        ...(result.inputId ? [`input_id: ${result.inputId}`] : []),
      ].join("\n"),
      metadata: {
        subagent: {
          action,
          started: false,
          accepted: true,
          inputId: result.inputId,
          agentId: execution.subagentId,
          executionId: execution.executionId,
          mode: execution.mode,
        },
      },
    };
  receipt.push(
    "accepted: true",
    "This agent is running in the background; do not edit the files assigned to it concurrently. Results arrive automatically.",
  );
  return {
    output: receipt.join("\n"),
    metadata: {
      subagent: {
        action,
        started: true,
        execution: executionSummary(execution),
        success: result.success,
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
      },
    },
  };
}
function statusSummary(result: SubagentStatusResult): Record<string, unknown> {
  return {
    items: result.items.map((item) => ({
      subagentId: item.subagentId,
      sessionId: item.sessionId,
      contextScopeId: item.contextScopeId,
      role: item.role,
      name: item.name,
      description: item.description,
      status: item.status,
      currentRunId: item.currentRunId,
      lastRunId: item.lastRunId,
    })),
    executions: result.executions.map(executionSummary),
    runtime: result.runtime,
  };
}
export function createSubagentTools(host: SubagentToolHost): readonly Tool[] {
  const agent: Tool = {
    category: "subagent",
    name: "agent",
    source: "builtin",
    timeoutOwner: "tool",
    description:
      "Manage independent agents: spawn creates an instance; send gives an existing instance a message; list lists open instances; monitor immediately reads saved records without waiting; stop interrupts work and preserves context; close permanently closes an instance. Spawn/send always run in the background; results arrive automatically and wake you, so finish this turn when no independent work remains. Sending to a running agent does not interrupt it; use stop then send to interrupt and continue. Do not poll monitor to wait. Keep completed instances for related follow-ups; close only obsolete instances, not to finish a turn or release execution slots. Give each writing agent an explicit, disjoint file scope and do not edit its files concurrently.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        prompt: {
          type: "string",
          description:
            "Spawn only: objective, known facts, owned/read-only files, and expected result.",
        },
        name: { type: "string" },
        description: { type: "string" },
        role: {
          type: "string",
          default: DEFAULT_SUBAGENT_ROLE,
          enum: [...SUBAGENT_ROLES],
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SUBAGENT_TIMEOUT_MS,
        },
        agent_id: { type: "string" },
        message: { type: "string" },
        agent_ids: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SUBAGENT_EXECUTIONS,
          uniqueItems: true,
          items: { type: "string" },
        },
        cursors: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    async execute(params, context): Promise<ToolExecutionResult> {
      const action = actionParam(params);
      const lookup = {
        parentSessionId: context.sessionId,
        parentContextScopeId: context.contextScopeId,
      };
      if (action === "list") {
        const result = await host.list(lookup);
        const summary = statusSummary(result);
        return {
          metadata: { subagentStatus: summary },
          output:
            JSON.stringify(summary) +
            (result.facts
              ? `\nExecution facts: ${renderExecutionFacts(result.facts)}`
              : ""),
        };
      }
      if (action === "monitor") {
        const result = await host.monitor({
          ...lookup,
          ...monitorParams(params),
        });
        return {
          metadata: { agentMonitor: result },
          output: JSON.stringify(result),
        };
      }
      if (action === "stop" || action === "close") {
        const result = await host[action]({
          parentSessionId: context.sessionId,
          subagentId: getRequiredNonEmptyStringParam(params, "agent_id"),
        });
        return {
          metadata: {
            [action === "stop" ? "subagentStop" : "subagentClose"]: result,
          },
          output: JSON.stringify({
            subagentId: result.subagentId,
            ...("stopped" in result
              ? { stopped: result.stopped }
              : { previousStatus: result.previousStatus }),
            cleanup: result.cleanup,
            reason: result.reason,
            unprocessedMessages: result.unprocessedMessages,
          }),
        };
      }
      if (!context.runId?.trim())
        throw new ToolParameterError(
          "agent spawn/send requires a real requester run identity.",
        );
      const input = {
        ...lookup,
        requesterRunId: context.runId,
        requesterMessageId: context.messageId,
        requestId: context.callId,
        environment: context.environment,
        signal: context.signal,
      };
      assertBackgroundMode(params);
      if (action === "send")
        return startResult(
          action,
          await host.send({
            ...input,
            subagentId: getRequiredNonEmptyStringParam(params, "agent_id"),
            prompt: getRequiredNonEmptyStringParam(params, "message"),
          }),
        );
      return startResult(
        action,
        await host.spawn({
          ...input,
          prompt: getRequiredNonEmptyStringParam(params, "prompt"),
          role: subagentRoleParam(params),
          name: getOptionalNonEmptyStringParam(params, "name"),
          description: getOptionalNonEmptyStringParam(params, "description"),
          timeoutMs: timeoutParam(params),
        }),
      );
    },
  };
  return [
    withToolAdmission(agent, {
      // Host execution leases own the six-slot limit, including immediate refusal.
      // A scheduler queue would delay running sends behind foreground calls.
      capacity: "control",
      category: (params) =>
        params.action === "list" || params.action === "monitor"
          ? "readonly"
          : "subagent",
      plan: () => [],
    }),
  ];
}
