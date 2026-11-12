import { randomUUID } from "node:crypto";
import type { ReasoningConfig } from "ohbaby-llm";
import type {
  GoalService,
  GoalTurnOutcome,
  GoalTurnTicket,
} from "../../goals/index.js";
import type { SessionSubagentSnapshot } from "../../agents/subagents/session-supervisor.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type { SessionExecutionGate } from "../session-execution.js";
import type { RunCompletion } from "../../runtime/run-manager/index.js";
import type { RunLedger } from "../../runtime/run-ledger/types.js";
import type {
  SubagentDelivery,
  SubagentWakeupDecision,
} from "../../agents/subagents/delivery.js";
export interface SubagentWakeupAdmission {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly candidates: readonly SubagentExecutionRecord[];
  readonly executions: Pick<SubagentExecutionStore, "claimWakeup">;
  readonly gate: SessionExecutionGate;
  readonly now: () => number;
  readonly reserveRunId?: () => Promise<string>;
  readonly checkWakeup?: (
    record: SubagentExecutionRecord,
  ) => Promise<SubagentWakeupDecision>;
  readonly canStart: () => Promise<boolean>;
  readonly reserveToken?: () => Promise<symbol | undefined>;
  readonly withSessionControl: <T>(
    sessionId: string,
    work: () => Promise<T>,
  ) => Promise<T>;
}
export function reserveSubagentWakeup(
  input: SubagentWakeupAdmission,
): Promise<symbol | undefined> {
  const isAborted = (): boolean => input.signal.aborted;
  return input.withSessionControl(input.sessionId, async () => {
    if (
      isAborted() ||
      input.gate.isHeld(input.sessionId) ||
      !(await input.canStart()) ||
      isAborted()
    )
      return undefined;
    const token = input.reserveToken
      ? await input.reserveToken()
      : Symbol("subagent result");
    if (!token || isAborted()) return undefined;
    if (!input.gate.reserve(input.sessionId, token)) return undefined;
    let admitted = false;
    try {
      const runId = await input.reserveRunId?.();
      for (const record of input.candidates) {
        if (isAborted()) break;
        if (
          record.rootSessionId !== input.sessionId ||
          record.mode !== "background" ||
          (record.delivery.state !== "pending" &&
            record.delivery.state !== "delivered") ||
          (input.checkWakeup
            ? !(await input.checkWakeup(record)).ready
            : record.delivery.wakeupAttemptedAt !== undefined)
        )
          continue;
        admitted =
          (await input.executions.claimWakeup(
            record,
            input.now(),
            runId
              ? { runId, previousRunId: record.delivery.wakeupRunId }
              : undefined,
          )) || admitted;
      }
      return admitted ? token : undefined;
    } catch (error) {
      admitted = false;
      throw error;
    } finally {
      if (!admitted) input.gate.release(token);
    }
  });
}

export interface SubagentWakeupSubmission {
  readonly owner: "subagent";
  readonly sessionId: string;
  readonly modelEntryId?: string;
  readonly reasoning?: ReasoningConfig;
  readonly hasModelSnapshot: true;
  readonly reservedRunId: string;
  readonly runtimeInput: {
    readonly kind: "subagent-status";
    readonly sourceId: string;
    readonly body: string;
  };
}
interface SubagentWakeupOptions {
  readonly runs: Pick<RunLedger, "get">;
  readonly executions: SubagentExecutionStore;
  readonly gate: SessionExecutionGate;
  readonly now: () => number;
  readonly reserveRunId: () => Promise<string>;
  readonly delivery: Pick<SubagentDelivery, "checkWakeup" | "resolveGoal">;
  readonly withSessionControl: SubagentWakeupAdmission["withSessionControl"];
  readonly prepareSession: (
    sessionId: string,
  ) => Promise<
    | { readonly modelEntryId?: string; readonly reasoning?: ReasoningConfig }
    | undefined
  >;
  readonly goals: Pick<
    GoalService,
    | "peekSnapshot"
    | "isAutomaticRunBudgetExhausted"
    | "admitTurnInBoundary"
    | "currentExecutionEpoch"
    | "pauseExecution"
    | "isExecutionCurrent"
    | "notifyWorkAvailable"
  >;
  readonly submit: (
    body: string,
    input: SubagentWakeupSubmission,
  ) => Promise<RunCompletion | undefined>;
  readonly runGoalTurn: (
    sessionId: string,
    ticket: GoalTurnTicket,
    input: SubagentWakeupSubmission,
  ) => Promise<GoalTurnOutcome>;
  readonly finishGoalTurn: (
    sessionId: string,
    ticket: GoalTurnTicket,
    outcome: GoalTurnOutcome,
  ) => Promise<void>;
  readonly goalHasRunningSubagents: (
    sessionId: string,
    goalId: string,
  ) => Promise<boolean>;
  readonly onReleased: (sessionId: string) => void;
  readonly onError: (sourceId: string, title: string, error: unknown) => void;
}

/** Admission, ownership, and result claiming share the existing session boundary. */
export function createSubagentWakeup(
  options: SubagentWakeupOptions,
): (sessionId: string, snapshot: SessionSubagentSnapshot) => Promise<boolean> {
  const goals = options.goals;
  return async (sessionId, snapshot) => {
    let session: Awaited<ReturnType<SubagentWakeupOptions["prepareSession"]>>;
    let goalTicket: GoalTurnTicket | undefined;
    let goalToAdmit: string | undefined;
    let runId: string | undefined;
    const candidates: SubagentExecutionRecord[] = [];
    let token: symbol | undefined;
    try {
      token = await reserveSubagentWakeup({
        sessionId,
        signal: snapshot.signal,
        candidates,
        executions: options.executions,
        gate: options.gate,
        now: options.now,
        checkWakeup: options.delivery.checkWakeup,
        reserveRunId: async () => {
          runId = await options.reserveRunId();
          return runId;
        },
        withSessionControl: options.withSessionControl,
        canStart: async () => {
          session = await options.prepareSession(sessionId);
          if (!session) return false;
          const goal = goals.peekSnapshot(sessionId);
          const goalResults: SubagentExecutionRecord[] = [];
          for (const record of snapshot.results) {
            const owner = await options.delivery.resolveGoal(record);
            if (owner === null) candidates.push(record);
            else if (
              owner !== undefined &&
              owner === goal?.goalId &&
              goal.status === "active"
            )
              goalResults.push(record);
          }
          const hasGoalWork = goalResults.length > 0;
          const budgetExhausted =
            goals.isAutomaticRunBudgetExhausted(sessionId);
          if (goal?.status === "active" && hasGoalWork && budgetExhausted) {
            // Let the existing Goal driver boundary block and reclaim its own work.
            await goals.admitTurnInBoundary(
              sessionId,
              goal.goalId,
              goals.currentExecutionEpoch(sessionId),
            );
          }
          if (goal?.status === "active" && hasGoalWork && !budgetExhausted) {
            goalToAdmit = goal.goalId;
            candidates.push(...goalResults);
          }
          return candidates.length > 0;
        },
        reserveToken: async () => {
          if (!goalToAdmit) return Symbol("subagent result");
          goalTicket =
            (await goals.admitTurnInBoundary(
              sessionId,
              goalToAdmit,
              goals.currentExecutionEpoch(sessionId),
            )) ?? undefined;
          return goalTicket?.token;
        },
      });
    } finally {
      if (!token && goalTicket)
        await options.finishGoalTurn(sessionId, goalTicket, {
          status: "not_admitted",
          usage: { totalTokens: 0, usageComplete: true },
        });
    }
    if (!token || !runId) return false;
    const sourceId = `subagent-result:${randomUUID()}`;
    const body =
      "Runtime subagent result wake-up. Process the delivered child results for the existing task. This is a runtime observation, not a new user request.";
    const wakeOptions: SubagentWakeupSubmission = {
      owner: "subagent",
      sessionId,
      ...session,
      hasModelSnapshot: true,
      reservedRunId: runId,
      runtimeInput: {
        kind: "subagent-status",
        sourceId,
        body: goalTicket ? `${goalTicket.modelText}\n${body}` : body,
      },
    };
    const admittedGoal = goalTicket;
    let goalTurnSucceeded = false;
    const completion = admittedGoal
      ? options
          .runGoalTurn(sessionId, admittedGoal, wakeOptions)
          .then(async (outcome) => {
            if (outcome.status === "cancelled" && !admittedGoal.stopIntent)
              await options.executions.stopWakeups(
                sessionId,
                wakeOptions.reservedRunId,
                options.now(),
              );
            await options.finishGoalTurn(sessionId, admittedGoal, outcome);
            goalTurnSucceeded = outcome.status === "succeeded";
            if (outcome.status === "cancelled" || outcome.status === "failed") {
              const stop = admittedGoal.stopIntent;
              await goals.pauseExecution(
                sessionId,
                admittedGoal.goalId,
                admittedGoal.executionEpoch,
                outcome.status === "cancelled"
                  ? (stop?.reason ?? "interrupted")
                  : `runtime error: ${outcome.error ?? "unknown"}`,
                outcome.status === "cancelled" && !stop ? "user" : "runtime",
              );
            }
          })
      : options.submit(body, wakeOptions).then(async (outcome) => {
          const run = await options.runs.get(wakeOptions.reservedRunId);
          const stopped =
            outcome?.status === "cancelled" ||
            run?.inputsCloseReason === "user-stop" ||
            run?.inputsCloseReason === "cancelled";
          if (stopped)
            await options.executions.stopWakeups(
              sessionId,
              wakeOptions.reservedRunId,
              options.now(),
            );
          else if (
            !outcome ||
            outcome.status === "failed" ||
            outcome.status === "interrupted"
          )
            options.onError(
              sourceId,
              "Subagent result processing failed",
              outcome?.error ??
                new Error("Automatic result processing did not start"),
            );
        });
    const isCurrentGoal = (): boolean =>
      admittedGoal !== undefined &&
      goals.isExecutionCurrent(
        sessionId,
        admittedGoal.goalId,
        admittedGoal.executionEpoch,
      );
    void completion
      .catch(async (error: unknown) => {
        options.onError(sourceId, "Subagent result processing failed", error);
        if (admittedGoal)
          await goals
            .pauseExecution(
              sessionId,
              admittedGoal.goalId,
              admittedGoal.executionEpoch,
              `runtime error: ${error instanceof Error ? error.message : String(error)}`,
              "runtime",
            )
            .catch((pauseError: unknown) => {
              options.onError(sourceId, "Goal pause failed", pauseError);
            });
      })
      .finally(() => {
        options.gate.release(token);
        options.onReleased(sessionId);
        if (
          admittedGoal &&
          goalTurnSucceeded &&
          !admittedGoal.recoveryPending &&
          isCurrentGoal()
        )
          void options
            .goalHasRunningSubagents(sessionId, admittedGoal.goalId)
            .then((running) => {
              if (
                (!running || goals.isAutomaticRunBudgetExhausted(sessionId)) &&
                isCurrentGoal()
              )
                goals.notifyWorkAvailable(sessionId);
            })
            .catch((error: unknown) => {
              options.onError(sourceId, "Goal continuation failed", error);
            });
      });
    return true;
  };
}
