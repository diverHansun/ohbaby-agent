import type { LifecycleRunInputPort } from "../../core/lifecycle/types.js";
import type { MessageWithParts } from "../../core/message/index.js";
import type { CurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type {
  SubagentExecutionStore,
  SubagentExecutionRecord,
} from "./execution-store.js";
import type { PreparedSubagentResult } from "./result-artifacts.js";

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
  readonly prepareResult: (
    execution: SubagentExecutionRecord,
    signal?: AbortSignal,
  ) => Promise<PreparedSubagentResult>;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  function createPort(identity: RunIdentity): LifecycleRunInputPort {
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
        const sourceId = execution.delivery.notificationId;
        if (!sourceId)
          throw new Error("Terminal execution has no notification identity");
        const old = execution.delivery.inputId
          ? await options.inputs.getInput(execution.delivery.inputId)
          : undefined;
        if (old?.processedRequestId) {
          await options.executions.markProcessed(
            execution,
            old.processedRequestId,
            old.processedAt ?? now(),
          );
          continue;
        }
        // Another live run must finish owning its request before a retry can bind elsewhere.
        if (old && old.runId !== identity.runId && old.closedAt === undefined)
          continue;
        const inputId = `${sourceId}:${identity.runId}`;
        if (!(await options.inputs.getInput(inputId))) {
          const result = await options.prepareResult(execution, signal);
          signal?.throwIfAborted();
          const at = now();
          const messageId = `runtime:${inputId}`;
          const message: MessageWithParts = {
            info: {
              id: messageId,
              sessionId: identity.sessionId,
              contextScopeId: identity.contextScopeId,
              runId: identity.runId,
              role: "user",
              agent: "default",
              time: { created: at, updated: at },
              runtimeInput: {
                kind: "subagent-result",
                inputId,
                targetRunId: identity.runId,
                sourceId,
              },
            },
            parts: [
              {
                id: `${messageId}:text`,
                messageId,
                sessionId: identity.sessionId,
                contextScopeId: identity.contextScopeId,
                orderIndex: 0,
                type: "text",
                text: result.body,
              },
            ],
          };
          await options.inputs.acceptRuntimeInput({
            inputId,
            sourceId,
            source: "subagent-result",
            runId: identity.runId,
            sessionId: identity.sessionId,
            contextScopeId: identity.contextScopeId,
            message,
          });
        }
        await options.executions.markDelivered(
          execution,
          inputId,
          now(),
          execution.delivery.inputId,
        );
        // Delivery to a busy run is already its automatic opportunity to consume this result.
        await options.executions.claimWakeup(execution, now());
      }
    }
    return {
      async beforeStep(signal, finalStep) {
        await reconcile(signal);
        if (finalStep) await options.inputs.sealSteer(identity.runId);
        return options.inputs.getMessages(identity.runId);
      },
      async beforeFinish(signal) {
        await reconcile(signal);
        signal?.throwIfAborted();
        return (await options.inputs.tryCloseForCompletion(identity.runId))
          ? "finish"
          : "continue";
      },
      admitRequestAttempt: (request, signal) =>
        options.inputs.admitRequestAttempt(request, signal),
      async confirmRequestSuccess(requestId) {
        const ids = await options.inputs.confirmRequestSuccess(requestId);
        for (const inputId of ids) {
          const input = await options.inputs.getInput(inputId);
          if (input?.source !== "subagent-result") continue;
          const executionId = input.sourceId.slice("subagent-result:".length);
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
  return { createPort };
}
