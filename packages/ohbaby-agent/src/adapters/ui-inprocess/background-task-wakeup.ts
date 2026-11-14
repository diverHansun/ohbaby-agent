import { RuntimeSwitchPendingError } from "./runtime-controller.js";
import type { ReasoningConfig } from "ohbaby-llm";
import type {
  GoalService,
  GoalTurnOutcome,
  GoalTurnTicket,
} from "../../goals/index.js";
import type { RunCompletion } from "../../runtime/run-manager/index.js";
import { ConcurrencyRejectedError } from "../../runtime/run-manager/index.js";
import {
  SessionRunBusyError,
  type RunLedger,
} from "../../runtime/run-ledger/index.js";
import type { CurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type { ShellJobStore } from "../../tools/shell-job-store.js";
import type { SessionExecutionGate } from "../session-execution.js";
import { backgroundTaskOpening } from "../ui-runtime/background-task-inputs.js";

export interface BackgroundWakeSubmission {
  readonly owner: "background-task";
  readonly sessionId: string;
  readonly modelEntryId?: string;
  readonly reasoning?: ReasoningConfig;
  readonly hasModelSnapshot: true;
  readonly reservedRunId: string;
  readonly runtimeInput: ReturnType<typeof backgroundTaskOpening> & {
    readonly goalReminder?: string;
  };
}

interface Options {
  readonly store: ShellJobStore;
  readonly isClosed: () => boolean;
  readonly inputs: CurrentRunInputStore;
  readonly runs: Pick<RunLedger, "get" | "getActiveRuns">;
  readonly gate: SessionExecutionGate;
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
  readonly reserveRunId: () => Promise<string>;
  readonly withSessionControl: <T>(
    id: string,
    work: () => Promise<T>,
  ) => Promise<T>;
  readonly prepareSession: (
    id: string,
  ) => Promise<
    | { readonly modelEntryId?: string; readonly reasoning?: ReasoningConfig }
    | undefined
  >;
  readonly hasUnknownActiveGoal: (id: string) => Promise<boolean>;
  readonly isGoalOwnedHere: (id: string, goalId: string) => Promise<boolean>;
  readonly submit: (
    text: string,
    input: BackgroundWakeSubmission,
  ) => Promise<RunCompletion | undefined>;
  readonly runGoalTurn: (
    id: string,
    ticket: GoalTurnTicket,
    input: BackgroundWakeSubmission,
  ) => Promise<GoalTurnOutcome>;
  readonly finishGoalTurn: (
    id: string,
    ticket: GoalTurnTicket,
    outcome: GoalTurnOutcome,
  ) => Promise<void>;
  readonly goalHasRunningSubagents: (
    id: string,
    goalId: string,
  ) => Promise<boolean>;
  readonly onDeferred?: (id: string) => void;
  readonly onReleased: (id: string, deferred?: boolean) => void;
  readonly onError: (id: string, error: unknown) => void;
}

/** A turn that never ran is refunded; otherwise its usage stays unknown. */
function notAdmitted(unstarted: boolean): GoalTurnOutcome {
  return {
    status: "not_admitted",
    ...(unstarted ? { refundUnstartedTurn: true } : {}),
    usage: unstarted
      ? { totalTokens: 0, usageComplete: true }
      : { usageComplete: false },
  };
}

/** One bounded attempt per session event. Durable batch CAS owns wake identity. */
export function createBackgroundTaskWakeup(
  options: Options,
): (sessionId: string) => Promise<boolean> {
  return async (sessionId) => {
    let ticket: GoalTurnTicket | undefined;
    let token: symbol | undefined;
    let batchId: string | undefined;
    let runId: string | undefined;
    let session: Awaited<ReturnType<Options["prepareSession"]>>;
    let claimed = false;
    const admission = { ready: false, unexpectedError: false };
    const releaseUnstarted = async (allowRelease = true): Promise<boolean> => {
      if (!runId || (await options.runs.get(runId))) return false;
      // The memory store cannot atomically see inputs; never release if any attempt exists.
      if (
        allowRelease &&
        claimed &&
        batchId &&
        (
          await options.inputs.listBySource(
            sessionId,
            `background-task:${batchId}`,
          )
        ).length === 0
      )
        await options.store.releaseUnstartedNoticeWake(batchId, runId);
      return true; // The unique run did not start, independently of who accepted the batch.
    };
    try {
      await options.withSessionControl(sessionId, async () => {
        if (options.isClosed() || options.gate.isHeld(sessionId)) return;
        session = await options.prepareSession(sessionId);
        if (
          !session ||
          options.isClosed() ||
          (await options.runs.getActiveRuns(sessionId)).some(
            (run) => run.contextScopeId === undefined,
          )
        )
          return;
        const goal = options.goals.peekSnapshot(sessionId);
        if (
          (!goal && (await options.hasUnknownActiveGoal(sessionId))) ||
          (goal && goal.status !== "active")
        )
          return;
        const goalId = goal?.goalId ?? null;
        if (goal && !(await options.isGoalOwnedHere(sessionId, goal.goalId)))
          return;
        const owner = { sessionId, contextScopeId: null };
        for (const candidate of options.store.listNoticeBatches(owner)) {
          const rows = options.store.getNoticeBatch(candidate);
          if (
            !rows.length ||
            !rows.every(
              (row) =>
                row.noticeState === "pending" &&
                row.noticeInputId === null &&
                row.noticeWakeRunId === null &&
                row.status !== "lost" &&
                row.goalId === goalId,
            )
          )
            continue;
          const attempts = await options.inputs.listBySource(
            sessionId,
            `background-task:${candidate}`,
          );
          let acceptedInputId: string | undefined;
          for (const attempt of attempts) {
            const actual = await options.inputs.reconcileRequestSuccess(
              attempt.inputId,
            );
            acceptedInputId = actual?.inputId ?? attempt.inputId;
            if (actual?.processedRequestId !== undefined) break;
          }
          if (acceptedInputId)
            await options.store.bindNoticeBatch(
              candidate,
              null,
              acceptedInputId,
            );
          const unavailable = acceptedInputId !== undefined;
          if (!unavailable) {
            batchId = candidate;
            break;
          }
        }
        batchId ??=
          (await options.store.allocateNoticeBatch(owner, {
            wakeGoalId: goalId,
          })) ?? undefined;
        if (!batchId) return;
        if (goal && options.goals.isAutomaticRunBudgetExhausted(sessionId)) {
          await options.goals.admitTurnInBoundary(
            sessionId,
            goal.goalId,
            options.goals.currentExecutionEpoch(sessionId),
          );
          return;
        }
        if (options.isClosed()) return;
        token = Symbol("background task admission");
        if (!options.gate.reserve(sessionId, token)) {
          token = undefined;
          return;
        }
        runId = await options.reserveRunId();
        if (options.isClosed()) return;
        claimed = await options.store.claimNoticeWake(batchId, runId, goalId);
        if (!claimed || options.isClosed()) return;
        if (goal) {
          ticket =
            (await options.goals.admitTurnInBoundary(
              sessionId,
              goal.goalId,
              options.goals.currentExecutionEpoch(sessionId),
            )) ?? undefined;
          if (!ticket || options.isClosed()) return;
          options.gate.release(token);
          token = ticket.token;
          if (!options.gate.reserve(sessionId, token)) {
            token = undefined;
            return;
          }
        }
        admission.ready = true;
      });
    } catch (error) {
      admission.ready = false;
      admission.unexpectedError = true;
      throw error;
    } finally {
      if (!admission.ready || options.isClosed()) {
        // This branch runs before submit; the CAS also rejects any accepted input.
        let unstarted = !runId;
        try {
          if (runId)
            unstarted = await releaseUnstarted(!admission.unexpectedError);
        } finally {
          if (token) options.gate.release(token);
          token = undefined;
          if (ticket)
            await options.finishGoalTurn(
              sessionId,
              ticket,
              notAdmitted(unstarted),
            );
        }
      }
    }
    if (!token || !batchId || !runId || !session || options.isClosed())
      return false;
    const heldToken = token;
    const claimedBatch = batchId;
    const claimedRun = runId;
    const admitted = ticket;
    let opening: ReturnType<typeof backgroundTaskOpening>;
    try {
      opening = backgroundTaskOpening(options.store, claimedBatch);
    } catch (error) {
      let unstarted = false;
      try {
        unstarted = await releaseUnstarted(false);
      } finally {
        options.gate.release(heldToken);
        if (admitted)
          await options.finishGoalTurn(
            sessionId,
            admitted,
            notAdmitted(unstarted),
          );
      }
      throw error;
    }
    const submission: BackgroundWakeSubmission = {
      owner: "background-task",
      sessionId,
      ...session,
      hasModelSnapshot: true,
      reservedRunId: claimedRun,
      runtimeInput: admitted
        ? { ...opening, goalReminder: admitted.modelText }
        : opening,
    };
    void (async () => {
      let goalSucceeded = false;
      let deferred = false;
      try {
        if (admitted) {
          const outcome = await options.runGoalTurn(
            sessionId,
            admitted,
            submission,
          );
          await options.finishGoalTurn(sessionId, admitted, outcome);
          goalSucceeded = outcome.status === "succeeded";
          if (outcome.status === "cancelled" || outcome.status === "failed")
            await options.goals.pauseExecution(
              sessionId,
              admitted.goalId,
              admitted.executionEpoch,
              outcome.status === "cancelled"
                ? (admitted.stopIntent?.reason ?? "interrupted")
                : `runtime error: ${outcome.error ?? "unknown"}`,
              outcome.status === "cancelled" && !admitted.stopIntent
                ? "user"
                : "runtime",
            );
        } else await options.submit(opening.body, submission);
      } catch (error) {
        if (
          (error instanceof SessionRunBusyError ||
            error instanceof ConcurrencyRejectedError ||
            error instanceof RuntimeSwitchPendingError) &&
          !(await options.runs.get(claimedRun))
        ) {
          deferred = true;
          options.onDeferred?.(sessionId);
          try {
            if (
              (
                await options.inputs.listBySource(
                  sessionId,
                  `background-task:${claimedBatch}`,
                )
              ).length === 0
            )
              await options.store.releaseUnstartedNoticeWake(
                claimedBatch,
                claimedRun,
              );
          } finally {
            if (admitted)
              await options.finishGoalTurn(
                sessionId,
                admitted,
                notAdmitted(true),
              );
          }
        } else {
          options.onError(sessionId, error);
          if (admitted) {
            await options.finishGoalTurn(sessionId, admitted, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              usage: { usageComplete: false },
            });
            await options.goals.pauseExecution(
              sessionId,
              admitted.goalId,
              admitted.executionEpoch,
              `runtime error: ${error instanceof Error ? error.message : String(error)}`,
              "runtime",
            );
          }
        }
      } finally {
        options.gate.release(heldToken);
        options.onReleased(sessionId, deferred);
        if (
          admitted &&
          goalSucceeded &&
          !admitted.recoveryPending &&
          options.goals.isExecutionCurrent(
            sessionId,
            admitted.goalId,
            admitted.executionEpoch,
          )
        ) {
          const running = await options.goalHasRunningSubagents(
            sessionId,
            admitted.goalId,
          );
          if (
            (!running ||
              options.goals.isAutomaticRunBudgetExhausted(sessionId)) &&
            options.goals.isExecutionCurrent(
              sessionId,
              admitted.goalId,
              admitted.executionEpoch,
            )
          )
            options.goals.notifyWorkAvailable(sessionId);
        }
      }
    })().catch((error: unknown) => {
      options.onError(sessionId, error);
    });
    return true;
  };
}
