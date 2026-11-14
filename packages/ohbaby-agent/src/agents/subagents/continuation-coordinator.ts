import { SUBAGENT_RESULT_SOURCE_PREFIX } from "./execution-store.js";
import type { RunInputSource } from "../../runtime/prompt-scheduler/run-input-coordinator.js";
import { buildRuntimeInputMessage } from "../../core/message/index.js";
import {
  CurrentRunInputConflictError,
  type CurrentRunInputStore,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type {
  SubagentExecutionStore,
  SubagentExecutionRecord,
} from "./execution-store.js";
import type { PreparedSubagentResult } from "./result-artifacts.js";
import type { SubagentDelivery } from "./delivery.js";

export interface SubagentWaitState {
  readonly waiting: boolean;
  readonly approvalBlocked: boolean;
}
interface RunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly isSubagent?: boolean;
}
export interface SubagentContinuationCoordinator {
  createSource(identity: RunIdentity): RunInputSource;
}

/** Page the durable session ledger; the history API's default 50 is not a lifecycle boundary. */
export async function listSessionExecutions(
  store: SubagentExecutionStore,
  sessionId: string,
): Promise<readonly SubagentExecutionRecord[]> {
  const result: SubagentExecutionRecord[] = [];
  let before: { createdAt: number; executionId: string } | undefined;
  for (;;) {
    const page = await store.list({
      rootSessionId: sessionId,
      limit: 200,
      before,
    });
    result.push(...page);
    if (page.length < 200) return result;
    const last = page[page.length - 1];
    before = { createdAt: last.createdAt, executionId: last.executionId };
  }
}

/** Request membership stays immutable. Each receiving run owns a separate delivery input. */
export function createSubagentContinuationCoordinator(options: {
  readonly executions: SubagentExecutionStore;
  readonly inputs: CurrentRunInputStore;
  readonly delivery: Pick<SubagentDelivery, "reconcile" | "canDeliver">;
  readonly prepareResult: (
    execution: SubagentExecutionRecord,
    signal?: AbortSignal,
  ) => Promise<PreparedSubagentResult>;
  readonly now?: () => number;
}): SubagentContinuationCoordinator {
  const now = options.now ?? Date.now;
  function createSource(identity: RunIdentity): RunInputSource {
    async function reconcile(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (identity.isSubagent) return;
      const sessionExecutions = (
        await listSessionExecutions(options.executions, identity.sessionId)
      ).filter(
        (record) =>
          record.parentSessionId === identity.sessionId &&
          record.requesterScopeId === (identity.contextScopeId ?? "primary"),
      );
      const executions = sessionExecutions.filter(
        (record) =>
          record.delivery.state === "pending" ||
          record.delivery.state === "delivered",
      );
      if (
        executions.length > 0 ||
        !sessionExecutions.some(
          (record) =>
            record.mode === "background" &&
            (record.status === "queued" || record.status === "running"),
        )
      )
        await options.inputs.dismissObservations(
          identity.runId,
          "subagent facts changed",
        );
      for (const execution of executions) {
        signal?.throwIfAborted();
        if (!(await options.delivery.canDeliver(execution, identity.runId)))
          continue;
        const reconciled = await options.delivery.reconcile(execution);
        if (reconciled.delivery.state === "processed") continue;
        const sourceId = execution.delivery.notificationId;
        if (!sourceId)
          throw new Error("Terminal execution has no notification identity");
        const old = reconciled.delivery.inputId
          ? await options.inputs.getInput(reconciled.delivery.inputId)
          : undefined;
        // Another live run must finish owning its request before a retry can bind elsewhere.
        if (old && old.runId !== identity.runId && old.closedAt === undefined)
          continue;
        const inputId = `${sourceId}:${identity.runId}`;
        if (!(await options.inputs.getInput(inputId))) {
          const result = await options.prepareResult(execution, signal);
          signal?.throwIfAborted();
          const at = now();
          const messageId = `runtime:${inputId}`;
          const message = buildRuntimeInputMessage({
            messageId,
            sessionId: identity.sessionId,
            contextScopeId: identity.contextScopeId,
            agent: "default",
            createdAt: at,
            origin: {
              kind: "subagent-result",
              inputId,
              targetRunId: identity.runId,
              sourceId,
            },
            text: result.body,
          });
          try {
            await options.inputs.acceptRuntimeInput({
              inputId,
              sourceId,
              source: "subagent-result",
              runId: identity.runId,
              sessionId: identity.sessionId,
              contextScopeId: identity.contextScopeId,
              message,
            });
          } catch (error) {
            if (
              error instanceof CurrentRunInputConflictError &&
              error.reason === "target-closed"
            )
              return;
            if (
              error instanceof CurrentRunInputConflictError &&
              error.reason === "source-rewound"
            )
              continue;
            throw error;
          }
        }
        await options.executions.markDelivered(
          execution,
          inputId,
          now(),
          reconciled.delivery.inputId,
        );
      }
    }
    return {
      reconcile,
      async confirmRequestSuccess(records, requestId): Promise<void> {
        for (const input of records) {
          if (input.source !== "subagent-result") continue;
          const executionId = input.sourceId.slice(
            SUBAGENT_RESULT_SOURCE_PREFIX.length,
          );
          const execution = await options.executions.getForRoot(
            executionId,
            identity.sessionId,
          );
          if (execution)
            await options.executions.markProcessed(
              execution,
              requestId,
              input.processedAt ?? now(),
            );
        }
      },
    };
  }
  return { createSource };
}
