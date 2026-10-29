import { randomUUID } from "node:crypto";
import type { ReasoningConfig } from "ohbaby-llm";
import type {
  GoalService,
  GoalTurnOutcome,
  GoalTurnTicket,
} from "../../goals/index.js";
import type { SessionSubagentSnapshot } from "../../agents/subagents/session-supervisor.js";
import { renderExecutionFacts } from "../../agents/subagents/execution-facts.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type { SessionExecutionGate } from "../session-execution.js";
export interface SubagentWakeupAdmission {
  readonly sessionId: string;
  readonly reason: "result" | "supervision";
  readonly signal: AbortSignal;
  readonly candidates: readonly SubagentExecutionRecord[];
  readonly executions: Pick<SubagentExecutionStore, "claimWakeup">;
  readonly gate: SessionExecutionGate;
  readonly now: () => number;
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
      : Symbol(`subagent ${input.reason}`);
    if (!token || isAborted()) return undefined;
    if (!input.gate.reserve(input.sessionId, token)) return undefined;
    let admitted = false;
    try {
      if (input.reason === "supervision") admitted = !isAborted();
      else
        for (const record of input.candidates) {
          if (isAborted()) break;
          if (
            record.rootSessionId !== input.sessionId ||
            record.mode !== "background" ||
            (record.delivery.state !== "pending" &&
              record.delivery.state !== "delivered") ||
            record.delivery.wakeupAttemptedAt !== undefined
          )
            continue;
          admitted =
            (await input.executions.claimWakeup(record, input.now())) ||
            admitted;
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
  readonly subagentWakeReason: "result" | "supervision";
  readonly sessionId: string;
  readonly modelEntryId?: string;
  readonly reasoning?: ReasoningConfig;
  readonly hasModelSnapshot: true;
  readonly runtimeInput: {
    readonly kind: "subagent-status";
    readonly sourceId: string;
    readonly body: string;
    readonly excludedSubagentRootRunIds?: readonly string[];
  };
}
interface SubagentWakeupOptions {
  readonly executions: SubagentExecutionStore;
  readonly gate: SessionExecutionGate;
  readonly now: () => number;
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
    | "getOwnedRunIds"
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
  ) => Promise<unknown>;
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
): (
  sessionId: string,
  reason: "result" | "supervision",
  snapshot: SessionSubagentSnapshot,
) => Promise<boolean> {
  const goals = options.goals;
  return async (sessionId, reason, snapshot) => {
    let session: Awaited<ReturnType<SubagentWakeupOptions["prepareSession"]>>;
    let goalTicket: GoalTurnTicket | undefined;
    let goalToAdmit: string | undefined;
    let excludedRoots: readonly string[] = [];
    const candidates: SubagentExecutionRecord[] = [];
    let token: symbol | undefined;
    try {
      token = await reserveSubagentWakeup({
        sessionId,
        reason,
        signal: snapshot.signal,
        candidates,
        executions: options.executions,
        gate: options.gate,
        now: options.now,
        withSessionControl: options.withSessionControl,
        canStart: async () => {
          session = await options.prepareSession(sessionId);
          if (!session) return false;
          const goal = goals.peekSnapshot(sessionId);
          const roots = new Set(goal ? goals.getOwnedRunIds(goal.goalId) : []);
          const eligible = snapshot.executions.filter(
            (record) =>
              record.rootSessionId === sessionId &&
              record.mode === "background" &&
              (reason === "result"
                ? (record.delivery.state === "pending" ||
                    record.delivery.state === "delivered") &&
                  record.delivery.wakeupAttemptedAt === undefined
                : record.status === "running" || record.status === "queued"),
          );
          const hasGoalWork = eligible.some((record) =>
            roots.has(record.rootRunId),
          );
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
          if (goal?.status === "active" && hasGoalWork && !budgetExhausted)
            goalToAdmit = goal.goalId;
          else if (budgetExhausted || goal?.status === "active")
            excludedRoots = [...roots];
          const excluded = new Set(excludedRoots);
          candidates.push(
            ...eligible.filter((record) => !excluded.has(record.rootRunId)),
          );
          return candidates.length > 0;
        },
        reserveToken: async () => {
          if (!goalToAdmit) return Symbol(`subagent ${reason}`);
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
    if (!token) return false;
    const sourceId = `subagent-${reason}:${randomUUID()}`;
    const allowed = new Set(candidates.map((record) => record.executionId));
    const body =
      reason === "result"
        ? "Runtime subagent result wake-up. Process the delivered child results for the existing task. This is a runtime observation, not a new user request."
        : `Runtime subagent supervision. Review the existing task using these saved facts; use agent list/monitor only for missing details. Do not poll or repeat an unchanged approval request.\n${renderExecutionFacts(snapshot.facts.filter((fact) => allowed.has(fact.executionId)))}`;
    const wakeOptions: SubagentWakeupSubmission = {
      owner: "subagent",
      subagentWakeReason: reason,
      sessionId,
      ...session,
      hasModelSnapshot: true,
      runtimeInput: {
        kind: "subagent-status",
        sourceId,
        body: goalTicket ? `${goalTicket.modelText}\n${body}` : body,
        ...(excludedRoots.length > 0
          ? { excludedSubagentRootRunIds: excludedRoots }
          : {}),
      },
    };
    const admittedGoal = goalTicket;
    let goalTurnSucceeded = false;
    const completion = admittedGoal
      ? options
          .runGoalTurn(sessionId, admittedGoal, wakeOptions)
          .then(async (outcome) => {
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
      : options.submit(body, wakeOptions);
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
