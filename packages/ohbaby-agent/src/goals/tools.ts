import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { formatGoalStatusLines } from "./injection.js";
import type {
  CreateGoalInput,
  GoalBudgetLimits,
  GoalSnapshot,
  GoalStatus,
} from "./types.js";

/** goal 工具的后端子集；GoalService 天然满足。 */
export interface GoalToolBackend {
  createGoal(sessionId: string, input: CreateGoalInput): Promise<GoalSnapshot>;
  updateGoalFromModel(
    sessionId: string,
    status: GoalStatus,
    reason?: string,
  ): Promise<{ readonly snapshot: GoalSnapshot | null; readonly note: string }>;
  getSnapshot(sessionId: string): Promise<GoalSnapshot | null>;
  setBudget(sessionId: string, limits: GoalBudgetLimits): Promise<GoalSnapshot>;
}

const GOAL_STATUSES = new Set<GoalStatus>(["active", "complete", "paused"]);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${field}: expected a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected a string.`);
  }
  return value;
}

function optionalPositiveInt(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(`Invalid ${field}: expected a positive integer.`);
  }
  return value;
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function createCreateGoalTool(backend: GoalToolBackend): Tool {
  return {
    name: "CreateGoal",
    description:
      "Create a durable goal the runtime will pursue autonomously across multiple turns. " +
      "Call this only when the user explicitly asks you to work autonomously toward an outcome " +
      "with a checkable end state. Do NOT create goals for greetings, ordinary questions, or " +
      "vague requests — ask the user for the missing completion criterion first. Use replace: true " +
      "only when the user explicitly wants to abandon the current goal.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        completionCriterion: {
          description: "Checkable success condition, if the user provided one.",
          type: "string",
        },
        objective: {
          description: "What must become true. Keep it concise.",
          type: "string",
        },
        replace: {
          description:
            "Replace the existing goal (requires explicit user intent).",
          type: "boolean",
        },
      },
      required: ["objective"],
      type: "object",
    },
    source: "builtin",
    category: "memory",
    async execute(params, context): Promise<ToolExecutionResult> {
      const objective = requireString(params.objective, "objective");
      const completionCriterion = optionalString(
        params.completionCriterion,
        "completionCriterion",
      );
      const replace = params.replace === true;
      const snapshot = await backend.createGoal(context.sessionId, {
        actor: "model",
        objective,
        replace,
        ...(completionCriterion !== undefined ? { completionCriterion } : {}),
      });
      return {
        metadata: { goalId: snapshot.goalId, status: snapshot.status },
        output: `Goal created (${snapshot.status}): ${truncate(snapshot.objective)}`,
      };
    },
  };
}

function createUpdateGoalTool(backend: GoalToolBackend): Tool {
  return {
    name: "UpdateGoal",
    description:
      "Update the current goal's lifecycle status after your self-audit. Call with `complete` " +
      "only when all required work is done and validated — never after just a plan or partial " +
      "result. Call with `paused` when the objective cannot proceed (external condition, " +
      "required user input, or an impossible objective). Resuming a paused goal is user-only " +
      "via /goal resume.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        reason: {
          description: "Short human-readable reason (for paused).",
          type: "string",
        },
        status: {
          enum: ["active", "paused", "complete"],
          type: "string",
        },
      },
      required: ["status"],
      type: "object",
    },
    source: "builtin",
    category: "memory",
    async execute(params, context): Promise<ToolExecutionResult> {
      const status = params.status;
      if (
        typeof status !== "string" ||
        !GOAL_STATUSES.has(status as GoalStatus)
      ) {
        throw new Error(`Invalid status: ${String(status)}`);
      }
      const reason = optionalString(params.reason, "reason");
      const result = await backend.updateGoalFromModel(
        context.sessionId,
        status as GoalStatus,
        reason,
      );
      return {
        metadata: { status: result.snapshot?.status ?? "cleared" },
        output: result.note,
      };
    },
  };
}

function createGetGoalTool(backend: GoalToolBackend): Tool {
  return {
    name: "GetGoal",
    description:
      "Read the current goal for this session: objective, status, progress and budget.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    source: "builtin",
    category: "memory",
    annotations: { readOnlyHint: true },
    async execute(_params, context): Promise<ToolExecutionResult> {
      const snapshot = await backend.getSnapshot(context.sessionId);
      if (snapshot === null) {
        return { output: "No goal is currently set." };
      }
      return {
        metadata: { goalId: snapshot.goalId, status: snapshot.status },
        output: formatGoalStatusLines(snapshot).join("\n"),
      };
    },
  };
}

function createSetGoalBudgetTool(backend: GoalToolBackend): Tool {
  return {
    name: "SetGoalBudget",
    description:
      "Record a hard budget for the current goal (turns, tokens, and/or minutes). Call this " +
      "only when the user explicitly states a budget limit — never invent budgets yourself. " +
      "When the budget is reached the goal pauses (resumable via /goal resume).",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        tokenBudget: {
          description: "Maximum cumulative tokens.",
          type: "number",
        },
        turnBudget: {
          description: "Maximum continuation turns.",
          type: "number",
        },
        wallClockBudgetMinutes: {
          description: "Maximum active wall-clock minutes.",
          type: "number",
        },
      },
      type: "object",
    },
    source: "builtin",
    category: "memory",
    async execute(params, context): Promise<ToolExecutionResult> {
      const turnBudget = optionalPositiveInt(params.turnBudget, "turnBudget");
      const tokenBudget = optionalPositiveInt(
        params.tokenBudget,
        "tokenBudget",
      );
      const minutes = optionalPositiveInt(
        params.wallClockBudgetMinutes,
        "wallClockBudgetMinutes",
      );
      if (
        turnBudget === undefined &&
        tokenBudget === undefined &&
        minutes === undefined
      ) {
        throw new Error(
          "SetGoalBudget requires at least one of turnBudget, tokenBudget, wallClockBudgetMinutes.",
        );
      }
      const snapshot = await backend.setBudget(context.sessionId, {
        ...(turnBudget !== undefined ? { turnBudget } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(minutes !== undefined
          ? { wallClockBudgetMs: minutes * 60_000 }
          : {}),
      });
      return {
        metadata: { budgetLimits: { ...snapshot.budgetLimits } },
        output: formatGoalStatusLines(snapshot).join("\n"),
      };
    },
  };
}

export function createGoalTools(backend: GoalToolBackend): Tool[] {
  return [
    createCreateGoalTool(backend),
    createUpdateGoalTool(backend),
    createGetGoalTool(backend),
    createSetGoalBudgetTool(backend),
  ];
}
