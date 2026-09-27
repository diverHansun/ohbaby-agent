export interface ExecutionBudgetSnapshot {
  readonly elapsedMs: number;
  readonly activeMs: number;
  readonly remainingMs: number;
  readonly approvalWaitMs: number;
}
/** One child-run quota. Approval pauses never reset or replenish elapsed work. */
export function createApprovalAwareDeadline(input: {
  readonly timeoutMs: number;
  readonly reason: string;
  readonly parent?: AbortSignal;
  readonly isApprovalBlocked: () => Promise<boolean>;
  readonly subscribe?: (wake: () => void) => () => void;
  readonly onFailure?: (error: Error) => void;
  readonly checkIntervalMs?: number;
  readonly checkTimeoutMs?: number;
  readonly now?: () => number;
}): {
  readonly signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
  snapshot(): ExecutionBudgetSnapshot;
} {
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const startedAt = now();
  let endedAt: number | undefined;
  let lastAccountedAt = startedAt;
  let remaining = input.timeoutMs;
  let paused = false;
  let timeout = false;
  let disposed = false;
  let checking = false;
  let dirty = false;
  let revision = 0;
  let failures = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = (): void => undefined;
  function clearTimers(): void {
    clearTimeout(deadlineTimer);
    clearTimeout(checkTimer);
  }
  function account(): void {
    const current = endedAt ?? now();
    if (!paused) remaining -= Math.max(0, current - lastAccountedAt);
    lastAccountedAt = current;
  }
  function scheduleDeadline(): void {
    clearTimeout(deadlineTimer);
    if (paused || disposed || controller.signal.aborted) return;
    deadlineTimer = setTimeout(
      () => {
        if (stopped()) return;
        account();
        endedAt = now();
        timeout = true;
        controller.abort(input.reason);
        clearTimers();
        unsubscribe();
      },
      Math.max(0, remaining),
    );
  }
  function dispose(): void {
    if (disposed) return;
    endedAt ??= now();
    account();
    disposed = true;
    clearTimers();
    unsubscribe();
    input.parent?.removeEventListener("abort", fromParent);
    if (!controller.signal.aborted)
      controller.abort("Execution budget disposed");
  }
  function fromParent(): void {
    endedAt ??= now();
    account();
    if (!controller.signal.aborted) controller.abort(input.parent?.reason);
    clearTimers();
    unsubscribe();
  }
  async function boundedCheck(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = (): void => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      cancel = (): void => {
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("Execution budget stopped"),
        );
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        reject(new Error("Approval state check timed out"));
      }, input.checkTimeoutMs ?? 5000);
    });
    try {
      return await Promise.race([input.isApprovalBlocked(), stopped]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
    }
  }
  const stopped = (): boolean => disposed || controller.signal.aborted;
  async function check(): Promise<void> {
    if (stopped()) return;
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    clearTimeout(checkTimer);
    try {
      const observedRevision = revision;
      const blocked = await boundedCheck();
      if (stopped()) return;
      account();
      paused = observedRevision === revision && blocked;
      failures = 0;
      scheduleDeadline();
    } catch (error) {
      if (stopped()) return;
      if (++failures >= 3) {
        const failure = new Error("Child execution supervision unavailable", {
          cause: error,
        });
        input.onFailure?.(failure);
        endedAt ??= now();
        account();
        controller.abort(failure);
        clearTimers();
        unsubscribe();
      }
    } finally {
      checking = false;
      if (!stopped()) {
        const delay = dirty ? 0 : (input.checkIntervalMs ?? 5000);
        dirty = false;
        checkTimer = setTimeout(() => {
          void check();
        }, delay);
      }
    }
  }
  input.parent?.addEventListener("abort", fromParent, { once: true });
  if (input.parent?.aborted) fromParent();
  else {
    unsubscribe =
      input.subscribe?.(() => {
        // A relevant transition invalidates the paused snapshot immediately.
        revision++;
        account();
        paused = false;
        scheduleDeadline();
        void check();
      }) ?? unsubscribe;
    scheduleDeadline();
    void check();
  }
  return {
    signal: controller.signal,
    didTimeout: () => timeout,
    dispose,
    snapshot() {
      account();
      const elapsedMs = Math.max(0, (endedAt ?? now()) - startedAt);
      const activeMs = Math.max(0, input.timeoutMs - remaining);
      return {
        elapsedMs,
        activeMs,
        remainingMs: Math.max(0, remaining),
        approvalWaitMs: Math.max(0, elapsedMs - activeMs),
      };
    },
  };
}
