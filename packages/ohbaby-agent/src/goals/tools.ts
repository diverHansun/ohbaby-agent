import {
  withToolAdmission,
  independentToolAdmission,
} from "../core/tool-scheduler/tool-admission.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { formatGoalStatusLines } from "./injection.js";
import type {
  CreateGoalInput,
  GoalBudgetLimits,
  GoalSnapshot,
} from "./types.js";
import { budgetLimitsFromInput, GOAL_BUDGET_UNITS } from "./budget-input.js";

/** goal 工具的后端子集；GoalService 天然满足。 */
export interface GoalToolBackend {
  createGoal(
    sessionId: string,
    input: CreateGoalInput,
    runId?: string,
  ): Promise<GoalSnapshot>;
  updateGoalFromModel(
    sessionId: string,
    status: "complete" | "blocked",
    reason?: string,
    runId?: string,
  ): Promise<{ readonly snapshot: GoalSnapshot | null; readonly note: string }>;
  getSnapshot(sessionId: string): Promise<GoalSnapshot | null>;
  setBudget(
    sessionId: string,
    limits: GoalBudgetLimits,
    runId?: string,
  ): Promise<GoalSnapshot>;
}

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
      "short as completeness allows. Use replace: true only when the user explicitly wants to " +
      "abandon the current goal. Replacement creates a new goal identity; do not assume the old " +
      "Goal's Todo list carries into the replacement.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        completionCriterion: {
          description:
            "Checkable success condition, if the user provided one. Trimmed before storage; " +
            "blank means omitted. Maximum 6000 UTF-16 code units, like the objective; " +
            "longer values are rejected, never truncated.",
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
      const snapshot = await backend.createGoal(
        context.sessionId,
        {
          actor: "model",
          objective,
          replace,
          ...(completionCriterion !== undefined ? { completionCriterion } : {}),
        },
        context.runId,
      );
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
      "result. On each genuinely blocked turn, call once with `blocked` and a nonblank reason " +
      "when an external condition, required user input, or an impossible objective prevents progress. " +
      "The backend counts consecutive goal turns with the same reason: 1/3 and 2/3 remain active, " +
      "so continue useful independent work; the third eligible turn becomes blocked. " +
      "Resuming a paused or blocked goal is user-only via /goal resume. " +
      "If you used Todo for this Goal, reconcile it before completion, but do " +
      "not treat Todo state as a runtime completion gate.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        reason: {
          description:
            "Required nonblank human-readable reason for blocked; ignored for complete.",
          type: "string",
        },
        status: {
          enum: ["complete", "blocked"],
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
      if (status !== "complete" && status !== "blocked") {
        throw new Error(`Invalid status: ${String(status)}`);
      }
      const reason =
        status === "blocked"
          ? requireString(params.reason, "reason").trim()
          : undefined;
      const result = await backend.updateGoalFromModel(
        context.sessionId,
        status,
        reason,
        context.runId,
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
      "Time measures all active goal time, including waiting, and excludes paused or blocked time. " +
      "A time limit is enforced during the current turn; reaching either limit blocks the goal. " +
      "Setting a budget does not resume a paused or blocked goal; only the user can resume it.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        unit: { enum: [...GOAL_BUDGET_UNITS], type: "string" },
        value: {
          description:
            "The positive numeric budget value explicitly stated by an authority.",
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
      const limits = budgetLimitsFromInput(params.value, params.unit);
      const snapshot = await backend.setBudget(
        context.sessionId,
        limits,
        context.runId,
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
  ].map((tool) => withToolAdmission(tool, independentToolAdmission));
}
