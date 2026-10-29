import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "./execution-store.js";
import { listSessionExecutions } from "./continuation-coordinator.js";
import type { ExecutionFactView } from "./execution-facts.js";

export interface SessionSubagentSnapshot {
  readonly executions: readonly SubagentExecutionRecord[];
  readonly facts: readonly ExecutionFactView[];
  readonly signal: AbortSignal;
}
export interface SessionSubagentSupervisorOptions {
  readonly executions: SubagentExecutionStore;
  readonly collectFacts: (
    execution: SubagentExecutionRecord,
  ) => Promise<ExecutionFactView>;
  readonly wake: (
    sessionId: string,
    reason: "result" | "supervision",
    snapshot: SessionSubagentSnapshot,
  ) => Promise<boolean>;
  readonly isIdle: (sessionId: string) => boolean;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}
export interface SessionSubagentSupervisor {
  observe(sessionId: string): void;
  active(sessionId: string, source: "user" | "result" | "supervision"): void;
  idle(sessionId: string, options?: { readonly interrupted?: boolean }): void;
  notify(sessionId: string): void;
  remove(sessionId: string): void;
  dispose(): void;
}

const FIRST_REVIEW_MS = 120_000;
const LATER_REVIEW_MS = 300_000;
const RECONCILE_MS = 5_000;
const MAX_UNCHANGED_REVIEWS = 3;

interface SessionState {
  readonly sessionId: string;
  controller: AbortController;
  idleAt?: number;
  delay: number;
  suppressed: boolean;
  unchangedReviews: number;
  resetVersion: number;
  executionFacts?: Map<string, string>;
  readonly approvals: Set<string>;
  acknowledgedApproval?: string;
  timer?: ReturnType<typeof setTimeout>;
  timerAt?: number;
  checking: boolean;
  dirty: boolean;
  pendingActivation: boolean;
}

export function createSessionSubagentSupervisor(
  options: SessionSubagentSupervisorOptions,
): SessionSubagentSupervisor {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionState>();
  let disposed = false;
  function clearTimer(state: SessionState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.timerAt = undefined;
  }
  function invalidate(state: SessionState): void {
    state.controller.abort();
    state.controller = new AbortController();
    clearTimer(state);
  }
  function resetReviews(state: SessionState): void {
    state.unchangedReviews = 0;
    state.resetVersion++;
  }
  function ensure(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionState = {
      sessionId,
      controller: new AbortController(),
      idleAt: options.isIdle(sessionId) ? now() : undefined,
      delay: FIRST_REVIEW_MS,
      suppressed: false,
      unchangedReviews: 0,
      resetVersion: 0,
      approvals: new Set(),
      checking: false,
      dirty: false,
      pendingActivation: false,
    };
    sessions.set(sessionId, state);
    return state;
  }
  function valid(state: SessionState, signal: AbortSignal): boolean {
    return (
      !disposed && sessions.get(state.sessionId) === state && !signal.aborted
    );
  }
  function arm(state: SessionState, at: number): void {
    if (state.timerAt === at) return;
    clearTimer(state);
    if (at <= now()) return;
    state.timerAt = at;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.timerAt = undefined;
      notify(state.sessionId);
    }, at - now());
    state.timer.unref();
  }
  function observeFacts(
    state: SessionState,
    executions: readonly SubagentExecutionRecord[],
    facts: readonly ExecutionFactView[],
  ): void {
    const next = new Map(
      executions.map((record) => [
        record.executionId,
        `${record.status}:${record.delivery.state}`,
      ]),
    );
    const previous = state.executionFacts;
    const newlyStarted =
      previous !== undefined &&
      executions.some(
        (record) =>
          !previous.has(record.executionId) &&
          (record.status === "queued" || record.status === "running"),
      );
    const changed =
      previous !== undefined &&
      executions.some(
        (record) =>
          previous.get(record.executionId) !== next.get(record.executionId),
      );
    state.executionFacts = next;
    let newApproval = false;
    for (const fact of facts)
      for (const permissionId of fact.approval.permissionIds) {
        const key = JSON.stringify([fact.executionId, permissionId]);
        if (!state.approvals.has(key)) {
          state.approvals.add(key);
          newApproval = true;
        }
      }
    if (changed || newApproval) {
      const exhausted = state.unchangedReviews >= MAX_UNCHANGED_REVIEWS;
      resetReviews(state);
      if (
        newlyStarted ||
        exhausted ||
        (newApproval && state.acknowledgedApproval)
      ) {
        state.delay = FIRST_REVIEW_MS;
        if (state.idleAt !== undefined) state.idleAt = now();
        clearTimer(state);
      }
    }
  }
  async function check(state: SessionState): Promise<void> {
    const signal = state.controller.signal;
    const executions = (
      await listSessionExecutions(options.executions, state.sessionId)
    ).filter(
      (record) =>
        record.mode === "background" &&
        record.parentSessionId === state.sessionId,
    );
    if (!valid(state, signal)) return;
    const running = executions.filter(
      (record) => record.status === "running" || record.status === "queued",
    );
    const facts = await Promise.all(running.map(options.collectFacts));
    if (!valid(state, signal)) return;
    observeFacts(state, executions, facts);
    if (
      state.idleAt === undefined ||
      !options.isIdle(state.sessionId) ||
      state.pendingActivation
    ) {
      clearTimer(state);
      return;
    }
    const snapshot = { executions, facts, signal };
    const results = executions.filter(
      (record) =>
        (record.delivery.state === "pending" ||
          record.delivery.state === "delivered") &&
        record.delivery.wakeupAttemptedAt === undefined,
    );
    if (results.length > 0) {
      if (
        (await options.wake(state.sessionId, "result", snapshot)) &&
        valid(state, signal)
      ) {
        state.pendingActivation = true;
        clearTimer(state);
      }
      return;
    }
    if (
      state.suppressed ||
      running.length === 0 ||
      state.unchangedReviews >= MAX_UNCHANGED_REVIEWS
    ) {
      clearTimer(state);
      return;
    }
    const allBlocked =
      facts.length === running.length &&
      facts.every((fact) => fact.approval.blocked);
    const approval = allBlocked
      ? JSON.stringify(
          facts
            .map((fact) => [
              fact.executionId,
              [...fact.approval.permissionIds].sort(),
            ])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        )
      : undefined;
    if (!allBlocked) state.acknowledgedApproval = undefined;
    if (approval !== undefined && approval === state.acknowledgedApproval) {
      clearTimer(state);
      return;
    }
    const dueAt = state.idleAt + state.delay;
    if (dueAt > now()) {
      arm(state, dueAt);
      return;
    }
    const resetVersion = state.resetVersion;
    const accepted = await options.wake(
      state.sessionId,
      "supervision",
      snapshot,
    );
    if (!accepted || disposed || sessions.get(state.sessionId) !== state)
      return;
    if (state.resetVersion === resetVersion) {
      state.unchangedReviews++;
      state.acknowledgedApproval = approval;
    }
    if (valid(state, signal)) {
      state.delay = LATER_REVIEW_MS;
      state.pendingActivation = true;
      clearTimer(state);
    }
  }
  function needsCheck(state: SessionState): boolean {
    return state.dirty && !disposed && sessions.get(state.sessionId) === state;
  }
  function notify(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (disposed || !state) return;
    state.dirty = true;
    if (state.checking) return;
    state.checking = true;
    void (async (): Promise<void> => {
      try {
        while (needsCheck(state)) {
          state.dirty = false;
          try {
            await check(state);
          } catch (error) {
            options.onError?.(error);
          }
        }
      } finally {
        state.checking = false;
      }
    })();
  }
  const unsubscribe = options.executions.subscribe((record) => {
    notify(record.rootSessionId);
  });
  const reconcile = setInterval(() => {
    for (const sessionId of sessions.keys()) notify(sessionId);
  }, RECONCILE_MS);
  reconcile.unref();
  return {
    observe(sessionId): void {
      if (!disposed) {
        ensure(sessionId);
        notify(sessionId);
      }
    },
    active(sessionId, source): void {
      if (disposed) return;
      const state = ensure(sessionId);
      invalidate(state);
      state.idleAt = undefined;
      state.pendingActivation = false;
      if (source === "supervision") state.delay = LATER_REVIEW_MS;
      else {
        state.suppressed = false;
        state.delay = FIRST_REVIEW_MS;
        state.acknowledgedApproval = undefined;
        resetReviews(state);
      }
      notify(sessionId);
    },
    idle(sessionId, input = {}): void {
      if (disposed) return;
      const state = ensure(sessionId);
      invalidate(state);
      state.idleAt = now();
      state.pendingActivation = false;
      if (input.interrupted) state.suppressed = true;
      notify(sessionId);
    },
    notify,
    remove(sessionId): void {
      const state = sessions.get(sessionId);
      if (state) {
        invalidate(state);
        sessions.delete(sessionId);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearInterval(reconcile);
      for (const state of sessions.values()) invalidate(state);
      sessions.clear();
    },
  };
}
