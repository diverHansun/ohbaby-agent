import { RuntimeInputSnapshotChangedError } from "../../core/lifecycle/runtime-input-error.js";
import type { LifecycleRunInputPort } from "../../core/lifecycle/types.js";
import type { MessageWithParts } from "../../core/message/index.js";
import type {
  CurrentRunInputStore,
  CurrentRunInputRecord,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type {
  SubagentExecutionStore,
  SubagentExecutionRecord,
} from "./execution-store.js";
import type { PreparedSubagentResult } from "./result-artifacts.js";
import {
  renderExecutionFacts,
  type ExecutionFactView,
} from "./execution-facts.js";

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
interface Snapshot {
  readonly executions: readonly SubagentExecutionRecord[];
  readonly open: readonly SubagentExecutionRecord[];
  readonly facts: readonly ExecutionFactView[];
  readonly approvalFingerprint?: string;
}
export function createSubagentContinuationCoordinator(options: {
  readonly executions: SubagentExecutionStore;
  readonly inputs: CurrentRunInputStore;
  readonly prepareResult: (
    execution: SubagentExecutionRecord,
    signal?: AbortSignal,
  ) => Promise<PreparedSubagentResult>;
  readonly collectFacts: (
    execution: SubagentExecutionRecord,
  ) => Promise<ExecutionFactView>;
  readonly subscribe?: (identity: RunIdentity, wake: () => void) => () => void;
  readonly now?: () => number;
  readonly checkIntervalMs?: number;
  readonly checkTimeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const listeners = new Map<string, Set<() => void>>();
  const waits = new Map<string, SubagentWaitState>();
  function notify(rootRunId: string): void {
    for (const wake of listeners.get(rootRunId) ?? []) wake();
  }
  function createPort(identity: RunIdentity): LifecycleRunInputPort {
    let generation = 0;
    let observationVersion = 0;
    let nextWaitMs = 60_000;
    let explainedApproval: string | undefined;
    let previousApproval: string | undefined;
    const observationFacts = new Map<string, string>();
    const factSignature = (snapshot: Snapshot): string =>
      JSON.stringify([
        snapshot.open.map((execution) => execution.executionId).sort(),
        snapshot.approvalFingerprint,
      ]);
    function runtimeMessage(
      inputId: string,
      source: CurrentRunInputRecord["source"],
      sourceId: string,
      body: string,
      at: number,
    ): MessageWithParts {
      const messageId = `runtime:${inputId}`;
      return {
        info: {
          id: messageId,
          sessionId: identity.sessionId,
          contextScopeId: identity.contextScopeId,
          runId: identity.runId,
          role: "user",
          agent: "default",
          time: { created: at, updated: at },
          runtimeInput: {
            kind: source,
            inputId,
            targetRunId: identity.runId,
            sourceId,
          },
        },
        parts: [
          {
            id: `${messageId}:text`,
            sessionId: identity.sessionId,
            contextScopeId: identity.contextScopeId,
            messageId,
            orderIndex: 0,
            type: "text",
            text: body,
          },
        ],
      };
    }
    async function accept(
      source: CurrentRunInputRecord["source"],
      sourceId: string,
      body: string,
      at: number,
      observation?: CurrentRunInputRecord["observation"],
    ): Promise<void> {
      const inputId = sourceId;
      await options.inputs.acceptRuntimeInput({
        inputId,
        sourceId,
        source,
        runId: identity.runId,
        sessionId: identity.sessionId,
        contextScopeId: identity.contextScopeId,
        message: runtimeMessage(inputId, source, sourceId, body, at),
        observation,
      });
    }
    async function reconcile(signal?: AbortSignal): Promise<Snapshot> {
      signal?.throwIfAborted();
      const executions = identity.isSubagent
        ? []
        : (await options.executions.listByRootRun(identity.runId)).filter(
            (e) =>
              e.requesterRunId === identity.runId &&
              e.parentSessionId === identity.sessionId &&
              e.requesterScopeId === (identity.contextScopeId ?? "primary"),
          );
      for (const execution of executions) {
        signal?.throwIfAborted();
        if (execution.delivery.state === "pending") {
          const inputId = execution.delivery.notificationId;
          if (!inputId)
            throw new Error("Terminal execution has no notification identity");
          // On replay the committed message is authoritative, even if a file later disappeared.
          if (!(await options.inputs.getInput(inputId))) {
            const result = await options.prepareResult(execution, signal);
            signal?.throwIfAborted();
            await accept(
              "subagent-result",
              inputId,
              result.body,
              execution.completedAt ?? execution.updatedAt,
            );
          }
          await options.executions.markDelivered(execution, inputId, now());
        }
        const inputId =
          execution.delivery.inputId ?? execution.delivery.notificationId;
        const input = inputId
          ? await options.inputs.getInput(inputId)
          : undefined;
        if (
          input?.processedRequestId &&
          execution.delivery.state !== "processed"
        )
          await options.executions.markProcessed(
            execution,
            input.processedRequestId,
            input.processedAt ?? now(),
          );
      }
      const open = executions.filter(
        (e) => e.status === "queued" || e.status === "running",
      );
      const facts = await Promise.all(open.map(options.collectFacts));
      signal?.throwIfAborted();
      const approvalFingerprint =
        facts.length > 0 &&
        facts.every((f) => f.approval.blocked && f.approval.fingerprint)
          ? JSON.stringify(
              facts
                .map((f) => [f.executionId, f.approval.fingerprint])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            )
          : undefined;
      const pending = await options.inputs.listPending(identity.runId);
      if (
        open.length === 0 ||
        pending.some((i) => i.source !== "subagent-status")
      )
        await options.inputs.dismissObservations(
          identity.runId,
          open.length === 0
            ? "executions-ended"
            : "superseded-by-business-input",
        );
      return { executions, open, facts, approvalFingerprint };
    }
    async function check(signal?: AbortSignal): Promise<Snapshot> {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = (): void => undefined;
        const failed = new Promise<never>((_resolve, reject) => {
          cancel = (): void => {
            controller.abort(signal?.reason);
            reject(abortError(signal?.reason));
          };
          signal?.addEventListener("abort", cancel, { once: true });
          timer = setTimeout(() => {
            const error = new Error("Subagent reconciliation timed out");
            controller.abort(error);
            reject(error);
          }, options.checkTimeoutMs ?? 5000);
        });
        try {
          return await Promise.race([reconcile(controller.signal), failed]);
        } catch (error) {
          signal?.throwIfAborted();
          if (attempt >= 2)
            throw new Error("Subagent supervision unavailable", {
              cause: error,
            });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        }
        await delay(options.checkIntervalMs ?? 5000, signal);
      }
    }
    async function observation(
      snapshot: Snapshot,
      reason: "deadline" | "approval-change",
    ): Promise<void> {
      await options.inputs.dismissObservations(
        identity.runId,
        "superseded-observation",
      );
      const at = now();
      const sourceId = `subagent-status:${identity.runId}:${String(generation)}:${String(++observationVersion)}`;
      observationFacts.set(sourceId, factSignature(snapshot));
      await accept(
        "subagent-status",
        sourceId,
        `Runtime subagent observation\nrootRunId: ${identity.runId}\nwaitGeneration: ${String(generation)}\nreason: ${reason}\nobservedAt: ${String(at)}\n${renderExecutionFacts(snapshot.facts)}\nAssess progress and next action. Explain any approval block to the user; approvals remain in the root session.`,
        at,
        {
          waitGeneration: generation,
          reason,
          approvalFingerprint: snapshot.approvalFingerprint,
          observedAt: at,
        },
      );
      previousApproval = snapshot.approvalFingerprint;
    }
    return {
      async beforeStep(signal, finalStep) {
        await check(signal);
        if (finalStep) await options.inputs.sealSteer(identity.runId);
        return options.inputs.getMessages(identity.runId);
      },
      async beforeFinish(signal) {
        if (identity.isSubagent)
          return (await options.inputs.tryCloseForCompletion(identity.runId))
            ? "finish"
            : "continue";
        generation++;
        let revision = 0;
        let waiter: (() => void) | undefined;
        const wake = (): void => {
          revision++;
          waiter?.();
        };
        const entries = listeners.get(identity.runId) ?? new Set();
        entries.add(wake);
        listeners.set(identity.runId, entries);
        const removeInput = options.inputs.subscribe(identity.runId, wake);
        const removeFacts = options.subscribe?.(identity, wake);
        let deadline = now() + nextWaitMs;
        let paused = false;
        try {
          for (;;) {
            const seen = revision;
            const snapshot = await check(signal);
            signal?.throwIfAborted();
            if ((await options.inputs.listPending(identity.runId)).length)
              return "continue";
            if (snapshot.open.length === 0) {
              if (await options.inputs.tryCloseForCompletion(identity.runId))
                return "finish";
              continue;
            }
            const fingerprint = snapshot.approvalFingerprint;
            if (
              fingerprint !== previousApproval &&
              (fingerprint !== undefined || previousApproval !== undefined)
            ) {
              previousApproval = fingerprint;
              if (
                fingerprint !== explainedApproval ||
                fingerprint === undefined
              ) {
                await observation(snapshot, "approval-change");
                return "continue";
              }
            }
            const shouldPause =
              fingerprint !== undefined && fingerprint === explainedApproval;
            if (paused && !shouldPause) deadline = now() + nextWaitMs;
            paused = shouldPause;
            if (!paused && now() >= deadline) {
              await observation(snapshot, "deadline");
              return "continue";
            }
            if (revision !== seen) continue;
            waits.set(identity.runId, {
              waiting: true,
              approvalBlocked: paused,
            });
            await new Promise<void>((resolve, reject) => {
              const duration = Math.min(
                options.checkIntervalMs ?? 5000,
                paused ? Infinity : Math.max(0, deadline - now()),
              );
              const timer = setTimeout(done, duration);
              function cleanup(): void {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                waiter = undefined;
              }
              function done(): void {
                cleanup();
                resolve();
              }
              function abort(): void {
                cleanup();
                reject(abortError(signal?.reason));
              }
              waiter = done;
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
              else if (revision !== seen) done();
            });
          }
        } finally {
          waits.delete(identity.runId);
          removeInput();
          removeFacts?.();
          entries.delete(wake);
          if (entries.size === 0) listeners.delete(identity.runId);
        }
      },
      async admitRequestAttempt(request, signal) {
        // Immutable observations are invalidated before their first attempt only.
        const before = await options.inputs.listPending(identity.runId);
        if (
          before.some(
            (i) =>
              request.inputIds?.includes(i.inputId) &&
              i.source === "subagent-status" &&
              i.firstAttemptRequestId === undefined,
          )
        ) {
          const snapshot = await check(signal);
          for (const pending of before) {
            if (
              !request.inputIds?.includes(pending.inputId) ||
              pending.source !== "subagent-status" ||
              pending.firstAttemptRequestId !== undefined
            )
              continue;
            const current = await options.inputs.getInput(pending.inputId);
            if (
              current?.closedAt === undefined &&
              observationFacts.get(pending.inputId) !== factSignature(snapshot)
            ) {
              await observation(
                snapshot,
                pending.observation?.reason ?? "deadline",
              );
              throw new RuntimeInputSnapshotChangedError();
            }
          }
          for (const id of request.inputIds ?? []) {
            const current = await options.inputs.getInput(id);
            if (current?.closedAt !== undefined)
              throw new RuntimeInputSnapshotChangedError();
          }
        }
        await options.inputs.admitRequestAttempt(request, signal);
      },
      async confirmRequestSuccess(requestId) {
        const ids = await options.inputs.confirmRequestSuccess(requestId);
        let businessInput = false;
        for (const id of ids) {
          const input = await options.inputs.getInput(id);
          if (!input) throw new Error("Processed runtime input disappeared");
          if (input.source !== "subagent-status") businessInput = true;
          else {
            nextWaitMs = 120_000;
            explainedApproval = input.observation?.approvalFingerprint;
          }
        }
        if (businessInput) nextWaitMs = 60_000;
      },
    };
  }
  return {
    createPort,
    notify,
    getWaitState: (rootRunId: string): SubagentWaitState =>
      waits.get(rootRunId) ?? { waiting: false, approvalBlocked: false },
  };
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError(signal?.reason));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "Run cancelled");
}
