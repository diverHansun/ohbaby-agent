import { buildRuntimeInputMessage } from "../../core/message/index.js";
import {
  CurrentRunInputConflictError,
  type CurrentRunInputStore,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type { RunInputSource } from "../../runtime/prompt-scheduler/run-input-coordinator.js";
import { renderShellJobNoticeBatch } from "../../tools/shell-job-notice.js";
import type {
  ShellJobNoticeOwner,
  ShellJobNoticeSelection,
  ShellJobRecord,
  ShellJobStore,
} from "../../tools/shell-job-store.js";

const SOURCE_PREFIX = "background-task:";
export function backgroundTaskOpening(
  store: ShellJobStore,
  batchId: string,
): {
  readonly kind: "background-task-result";
  readonly sourceId: string;
  readonly body: string;
} {
  const rows = store.getNoticeBatch(batchId);
  if (!rows.length || rows.some((row) => row.noticePayload === null))
    throw new Error("Background result batch is not frozen.");
  return {
    kind: "background-task-result",
    sourceId: `${SOURCE_PREFIX}${batchId}`,
    body: renderShellJobNoticeBatch(
      batchId,
      rows.map((row) => {
        if (row.noticePayload === null)
          throw new Error("Background result payload is missing.");
        return row.noticePayload;
      }),
    ),
  };
}

/** Delivery is separate from reading a task result. Successful request membership owns consumption. */
export function createBackgroundTaskInputSource(options: {
  readonly store: ShellJobStore;
  readonly inputs: CurrentRunInputStore;
  readonly deliverySelection?: () => Promise<
    Pick<ShellJobNoticeSelection, "deliveryGoalId" | "includeLost">
  >;
  readonly identity: ShellJobNoticeOwner & { readonly runId: string };
}): RunInputSource {
  const { store, inputs, identity } = options;
  const belongs = (row: ShellJobRecord): boolean =>
    row.sessionId === identity.sessionId &&
    row.contextScopeId === identity.contextScopeId &&
    (identity.contextScopeId === null || row.rootRunId === identity.runId);

  async function bind(batchId: string, inputId: string): Promise<void> {
    const rows = store.getNoticeBatch(batchId);
    if (!rows.length || !rows.every(belongs)) return;
    if (
      rows.every(
        (row) =>
          row.noticeInputId === inputId && row.noticeState === "accepted",
      )
    )
      return;
    await store.bindNoticeBatch(batchId, rows[0].noticeInputId, inputId);
  }
  async function deliver(
    batchId: string,
    signal?: AbortSignal,
    selection: ShellJobNoticeSelection = {},
  ): Promise<"skip" | "received"> {
    const rows = store.getNoticeBatch(batchId);
    if (
      !rows.length ||
      !rows.every(
        (row) =>
          belongs(row) &&
          (selection.includeLost !== false || row.status !== "lost") &&
          (selection.deliveryGoalId === undefined ||
            row.goalId === null ||
            row.goalId === selection.deliveryGoalId),
      )
    )
      return "skip";
    const sourceId = `${SOURCE_PREFIX}${batchId}`;
    const attempts = await inputs.listBySource(identity.sessionId, sourceId);
    for (const attempt of attempts) {
      const actual = await inputs.reconcileRequestSuccess(attempt.inputId);
      if (actual?.processedRequestId !== undefined) {
        await bind(batchId, actual.inputId);
        return "skip";
      }
    }
    const current = attempts.find((input) => input.runId === identity.runId);
    if (current) {
      await bind(batchId, current.inputId);
      return current.firstAttemptRequestId === undefined &&
        current.closedAt === undefined
        ? "received"
        : "skip";
    }
    if (attempts.some((input) => input.closedAt === undefined)) return "skip";
    signal?.throwIfAborted();
    const opening = backgroundTaskOpening(store, batchId);
    const inputId = `${sourceId}:${identity.runId}`;
    try {
      await inputs.acceptRuntimeInput({
        inputId,
        sourceId,
        source: "background-task-result",
        runId: identity.runId,
        sessionId: identity.sessionId,
        contextScopeId: identity.contextScopeId ?? undefined,
        message: buildRuntimeInputMessage({
          messageId: `runtime:${inputId}`,
          sessionId: identity.sessionId,
          contextScopeId: identity.contextScopeId ?? undefined,
          agent: "default",
          createdAt: rows[0].resultReadyAt ?? rows[0].createdAt,
          origin: {
            kind: "background-task-result",
            inputId,
            targetRunId: identity.runId,
            sourceId,
          },
          text: opening.body,
        }),
      });
    } catch (error) {
      if (
        error instanceof CurrentRunInputConflictError &&
        error.reason === "target-closed"
      )
        return "received";
      throw error;
    }
    await bind(batchId, inputId);
    return "received";
  }
  return {
    async reconcile(signal): Promise<void> {
      const selection = (await options.deliverySelection?.()) ?? {};
      const batches = store.listNoticeBatches(identity);
      for (const batchId of batches) {
        signal?.throwIfAborted();
        if ((await deliver(batchId, signal, selection)) === "received") return;
      }
      signal?.throwIfAborted();
      const allocated = await store.allocateNoticeBatch(identity, selection);
      if (allocated) await deliver(allocated, signal, selection);
    },
    async confirmRequestSuccess(records): Promise<void> {
      for (const record of records) {
        if (
          record.source !== "background-task-result" ||
          !record.sourceId.startsWith(SOURCE_PREFIX) ||
          record.processedRequestId === undefined
        )
          continue;
        await bind(record.sourceId.slice(SOURCE_PREFIX.length), record.inputId);
      }
    },
  };
}
