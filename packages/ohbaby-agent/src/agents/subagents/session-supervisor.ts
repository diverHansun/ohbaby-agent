import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "./execution-store.js";
import { listSessionExecutions } from "./continuation-coordinator.js";
import type { SubagentWakeupDecision } from "./delivery.js";

export interface SessionSubagentSnapshot {
  readonly results: readonly SubagentExecutionRecord[];
  readonly signal: AbortSignal;
}
export interface SessionSubagentSupervisorOptions {
  readonly executions: SubagentExecutionStore;
  readonly wake: (
    sessionId: string,
    snapshot: SessionSubagentSnapshot,
  ) => Promise<boolean>;
  readonly isIdle: (sessionId: string) => boolean;
  readonly now?: () => number;
  readonly checkWakeup?: (
    record: SubagentExecutionRecord,
  ) => Promise<SubagentWakeupDecision>;
  readonly onError?: (error: unknown) => void;
}
export interface SessionSubagentSupervisor {
  observe(sessionId: string): void;
  active(sessionId: string): void;
  idle(sessionId: string): void;
  notify(sessionId: string): void;
  remove(sessionId: string): void;
  dispose(): void;
}

const RECONCILE_MS = 5_000;
const MAX_ERROR_RETRIES = 3;

interface SessionState {
  readonly sessionId: string;
  controller: AbortController;
  hasRunningBackground: boolean;
  errorRetries: number;
  retryAt?: number;
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
    state.errorRetries = 0;
    state.retryAt = undefined;
    clearTimer(state);
  }
  function ensure(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionState = {
      sessionId,
      controller: new AbortController(),
      hasRunningBackground: false,
      errorRetries: 0,
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
    state.hasRunningBackground = executions.some(
      (record) => record.status === "running" || record.status === "queued",
    );
    if (!options.isIdle(state.sessionId) || state.pendingActivation) return;
    const results: SubagentExecutionRecord[] = [];
    let retryAt: number | undefined;
    for (const record of executions) {
      if (
        record.delivery.state !== "pending" &&
        record.delivery.state !== "delivered"
      )
        continue;
      const decision = options.checkWakeup
        ? await options.checkWakeup(record)
        : { ready: record.delivery.wakeupAttemptedAt === undefined };
      if (!valid(state, signal)) return;
      if (decision.ready) results.push(record);
      else if (decision.retryAt !== undefined)
        retryAt = Math.min(retryAt ?? Infinity, decision.retryAt);
    }
    // A fresh result can wake immediately; an older entrance retry must not hold it back.
    if (retryAt !== undefined) arm(state, retryAt);
    if (
      results.length > 0 &&
      (await options.wake(state.sessionId, { results, signal })) &&
      valid(state, signal)
    )
      state.pendingActivation = true;
  }
  function needsCheck(state: SessionState): boolean {
    return (
      state.dirty &&
      !disposed &&
      sessions.get(state.sessionId) === state &&
      (state.retryAt === undefined || state.retryAt <= now())
    );
  }
  function notify(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (disposed || !state) return;
    state.dirty = true;
    if (state.retryAt !== undefined && state.retryAt > now()) {
      arm(state, state.retryAt);
      return;
    }
    if (state.checking) return;
    state.checking = true;
    void (async (): Promise<void> => {
      try {
        while (needsCheck(state)) {
          state.dirty = false;
          state.retryAt = undefined;
          const signal = state.controller.signal;
          try {
            await check(state);
            state.errorRetries = 0;
          } catch (error) {
            if (valid(state, signal)) {
              if (state.errorRetries < MAX_ERROR_RETRIES) {
                // Re-read durable delivery before retrying: a claimed result is never
                // eligible again. Notify during gate release must obey this backoff.
                state.retryAt = now() + RECONCILE_MS * 2 ** state.errorRetries;
                state.errorRetries++;
                arm(state, state.retryAt);
              } else {
                state.dirty = false;
                clearTimer(state);
              }
            }
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
    for (const state of sessions.values())
      if (state.hasRunningBackground) notify(state.sessionId);
  }, RECONCILE_MS);
  reconcile.unref();
  return {
    observe(sessionId): void {
      if (!disposed) {
        ensure(sessionId);
        notify(sessionId);
      }
    },
    active(sessionId): void {
      if (disposed) return;
      const state = ensure(sessionId);
      invalidate(state);
      state.pendingActivation = true;
      notify(sessionId);
    },
    idle(sessionId): void {
      if (disposed) return;
      const state = ensure(sessionId);
      invalidate(state);
      state.pendingActivation = false;
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
