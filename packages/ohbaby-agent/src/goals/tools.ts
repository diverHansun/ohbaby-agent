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
import { GOAL_SAFETY_CAP_TURNS } from "./constants.js";

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

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${field}: expected a positive number.`);
  }
  return value;
}

const MIN_TIME_BUDGET_MS = 1_000;
const MAX_TIME_BUDGET_MS = 24 * 60 * 60 * 1_000;
const GOAL_BUDGET_UNITS = [
  "turns",
  "tokens",
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
] as const;
type GoalBudgetUnit = (typeof GOAL_BUDGET_UNITS)[number];

function isGoalBudgetUnit(value: unknown): value is GoalBudgetUnit {
  return (
    typeof value === "string" &&
    GOAL_BUDGET_UNITS.includes(value as GoalBudgetUnit)
  );
}

function timeBudgetMs(value: number, unit: GoalBudgetUnit): number | undefined {
  const factor =
    unit === "milliseconds"
      ? 1
      : unit === "seconds"
        ? 1_000
        : unit === "minutes"
          ? 60_000
          : unit === "hours"
            ? 3_600_000
            : undefined;
  return factor === undefined ? undefined : Math.round(value * factor);
}

function budgetLimitsFromInput(
  value: number,
  unit: GoalBudgetUnit,
): GoalBudgetLimits {
  if (unit === "turns") {
    const turnBudget = Math.max(1, Math.round(value));
    if (turnBudget > GOAL_SAFETY_CAP_TURNS) {
      throw new Error(
        `Invalid turn budget: system safety cap is ${String(GOAL_SAFETY_CAP_TURNS)} turns.`,
      );
    }
    return { turnBudget };
  }
  if (unit === "tokens") {
    return { tokenBudget: Math.max(1, Math.round(value)) };
  }
  const wallClockBudgetMs = timeBudgetMs(value, unit);
  if (
    wallClockBudgetMs === undefined ||
    wallClockBudgetMs < MIN_TIME_BUDGET_MS ||
    wallClockBudgetMs > MAX_TIME_BUDGET_MS
  ) {
    throw new Error("Invalid time budget: expected a duration from 1 second to 24 hours.");
  }
  return { wallClockBudgetMs };
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
      "vague requests — ask the user for the missing completion criterion first. " +
      "The objective must be self-contained: later turns may only see a compressed summary of " +
      "this conversation, so fold into the objective every constraint, decision, and rejected " +
      "direction already agreed here that would change how the work is done. Never reference " +
      "the conversation itself (no 'as discussed above', 'the approach we chose'). Keep it as " +
      "short as completeness allows. Use replace: true " +
      "only when the user explicitly wants to abandon the current goal.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        completionCriterion: {
          description: "Checkable success condition, if the user provided one.",
          type: "string",
        },
        objective: {
          description:
            "What must become true, written to stand alone without this conversation. " +
            "Include agreed constraints and decisions; keep it as short as completeness allows.",
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
      "Translate one explicit hard limit from the user, system, or developer into a structured " +
      "budget for the current goal. Never estimate, infer, recommend, or invent a budget. Set " +
      "one dimension per call; call again only when another dimension was explicitly stated. " +
      "Time measures active goal pursuit, excludes paused time, and is enforced at continuation " +
      "boundaries rather than as an exact deadline. When reached, the goal pauses and remains resumable.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        unit: { enum: [...GOAL_BUDGET_UNITS], type: "string" },
        value: {
          description: "The positive numeric budget value explicitly stated by an authority.",
          exclusiveMinimum: 0,
          type: "number",
        },
      },
      required: ["value", "unit"],
      type: "object",
    },
    source: "builtin",
    category: "memory",
    async execute(params, context): Promise<ToolExecutionResult> {
      const value = requirePositiveNumber(params.value, "value");
      if (!isGoalBudgetUnit(params.unit)) {
        throw new Error("Invalid unit for SetGoalBudget.");
      }
      const snapshot = await backend.setBudget(
        context.sessionId,
        budgetLimitsFromInput(value, params.unit),
      );
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
