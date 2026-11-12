import { SUBAGENT_ENTRANCE_RETRIES } from "./execution-store.js";
import type { GoalPersistencePort } from "../../goals/types.js";
import type { CurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type { RunLedger } from "../../runtime/run-ledger/types.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "./execution-store.js";

export interface SubagentWakeupDecision {
  readonly ready: boolean;
  readonly retryAt?: number;
}
export interface SubagentDelivery {
  resolveGoal(
    execution: SubagentExecutionRecord,
  ): Promise<string | null | undefined>;
  canDeliver(
    execution: SubagentExecutionRecord,
    runId: string,
  ): Promise<boolean>;
  reconcile(
    execution: SubagentExecutionRecord,
  ): Promise<SubagentExecutionRecord>;
  checkWakeup(
    execution: SubagentExecutionRecord,
  ): Promise<SubagentWakeupDecision>;
}
export function createSubagentDelivery(options: {
  readonly executions: SubagentExecutionStore;
  readonly inputs: CurrentRunInputStore;
  readonly runs: RunLedger;
  readonly goalHistory: Pick<GoalPersistencePort, "list">;
  readonly receivingGoal?: (
    sessionId: string,
    runId: string,
  ) => string | undefined;
  readonly now?: () => number;
}): SubagentDelivery {
  const now = options.now ?? Date.now;
  async function resolveGoal(
    execution: SubagentExecutionRecord,
  ): Promise<string | null | undefined> {
    if (execution.goalId !== undefined) return execution.goalId;
    // The built-in persistence port returns the complete append-only history.
    return (await options.goalHistory.list(execution.rootSessionId)).length ===
      0
      ? null
      : undefined;
  }
  async function reconcile(
    execution: SubagentExecutionRecord,
  ): Promise<SubagentExecutionRecord> {
    if (
      !execution.delivery.notificationId ||
      execution.rewoundAt ||
      execution.delivery.state === "processed"
    )
      return execution;
    // Input acceptance and the execution projection are separate writes. Recover
    // the link by stable source identity, including attempts from earlier runs.
    const inputs = (
      await options.inputs.listBySource(
        execution.rootSessionId,
        execution.delivery.notificationId,
      )
    ).filter(
      (input) =>
        input.source === "subagent-result" &&
        (input.contextScopeId ?? "primary") === execution.requesterScopeId,
    );
    for (const candidate of inputs) {
      const input = await options.inputs.reconcileRequestSuccess(
        candidate.inputId,
      );
      if (input?.processedRequestId) {
        await options.executions.markDelivered(
          execution,
          input.inputId,
          input.acceptedAt,
          execution.delivery.inputId,
        );
        return options.executions.markProcessed(
          execution,
          input.processedRequestId,
          input.processedAt ?? now(),
        );
      }
      // Cache an incidental attempt before its input can be rebound to another run.
      if (
        input?.firstAttemptRequestId &&
        execution.delivery.wakeupAttemptedAt === undefined
      )
        await options.executions.claimWakeup(
          execution,
          input.firstAttemptAt ?? now(),
        );
    }
    if (!execution.delivery.inputId && inputs.length) {
      const latest = inputs[inputs.length - 1];
      await options.executions.markDelivered(
        execution,
        latest.inputId,
        latest.acceptedAt,
      );
    }
    return (await options.executions.get(execution)) ?? execution;
  }
  return {
    resolveGoal,
    async canDeliver(execution, runId): Promise<boolean> {
      const run = await options.runs.get(runId);
      // A new user request may inspect saved work without resuming its old Goal.
      if (
        run?.sessionId === execution.rootSessionId &&
        run.triggerSource === "user"
      )
        return true;
      const goalId = await resolveGoal(execution);
      return (
        goalId === null ||
        (goalId !== undefined &&
          goalId === options.receivingGoal?.(execution.rootSessionId, runId))
      );
    },
    reconcile,
    async checkWakeup(execution): Promise<SubagentWakeupDecision> {
      const record = await reconcile(execution);
      if (
        record.rewoundAt ||
        record.mode !== "background" ||
        !["pending", "delivered"].includes(record.delivery.state)
      )
        return { ready: false };
      const input = record.delivery.inputId
        ? await options.inputs.getInput(record.delivery.inputId)
        : undefined;
      if (record.delivery.inputId && (!input || input.firstAttemptRequestId))
        return { ready: false };
      if (input && input.closedAt === undefined) return { ready: false };
      const { wakeupAttemptedAt, wakeupRunId, wakeupRetriesRemaining } =
        record.delivery;
      if (wakeupAttemptedAt === undefined) return { ready: true };
      if (!wakeupRunId || (wakeupRetriesRemaining ?? 0) <= 0)
        return { ready: false };
      const run = await options.runs.get(wakeupRunId);
      if (
        run &&
        (run.sessionId !== record.rootSessionId ||
          ["pending", "running", "cancelled"].includes(run.status) ||
          run.inputsCloseReason === "user-stop" ||
          run.inputsCloseReason === "cancelled")
      )
        return { ready: false };
      if (
        (await options.inputs.listByRun(wakeupRunId)).some(
          (item) => item.firstAttemptRequestId !== undefined,
        )
      )
        return { ready: false };
      const retryAt =
        wakeupAttemptedAt +
        5_000 *
          2 ** (SUBAGENT_ENTRANCE_RETRIES - (wakeupRetriesRemaining ?? 0));
      return retryAt > now() ? { ready: false, retryAt } : { ready: true };
    },
  };
}
