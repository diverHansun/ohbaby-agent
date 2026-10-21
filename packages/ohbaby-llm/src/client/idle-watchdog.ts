/** Last-resort provider silence limit, not a total request deadline. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

export class ProviderStreamIdleTimeoutError extends Error {
  readonly code = "PROVIDER_STREAM_IDLE_TIMEOUT";

  constructor(
    readonly idleMs: number,
    readonly timeoutMs: number,
  ) {
    super(
      `Provider stream idle for ${String(idleMs)}ms (limit ${String(timeoutMs)}ms)`,
    );
    this.name = "ProviderStreamIdleTimeoutError";
  }
}

export function validateStreamIdleTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(
      `Invalid idleTimeoutMs: ${String(value)}. Must be positive, finite, and at most 2147483647`,
    );
  }
  return value;
}

interface IdleWatchdog {
  readonly providerSignal: AbortSignal;
  wait<T>(pending: Promise<T>): Promise<T>;
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>;
  pulse(): void;
  expired(): boolean;
  dispose(): void;
}

/** One attempt owns one outstanding provider wait. Consumer work is untimed. */
export function createIdleWatchdog(input: {
  signal: AbortSignal | undefined;
  timeoutMs: number;
}): IdleWatchdog {
  const timeoutMs = validateStreamIdleTimeoutMs(input.timeoutMs);
  const timeout = new AbortController();
  const providerSignal = input.signal
    ? AbortSignal.any([input.signal, timeout.signal])
    : timeout.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let cancelWait: ((reason: unknown) => void) | undefined;

  const clearTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    clearTimer();
    const lastActivityAt = Date.now();
    timer = setTimeout(() => {
      timeout.abort(
        new ProviderStreamIdleTimeoutError(
          Math.max(0, Date.now() - lastActivityAt),
          timeoutMs,
        ),
      );
    }, timeoutMs);
  };

  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    // Even rejected input to a retired guard must have a rejection handler.
    if (disposed || cancelWait || providerSignal.aborted) {
      void pending.catch(() => undefined);
      throw (
        providerSignal.reason ??
        new Error(
          disposed
            ? "Idle watchdog disposed"
            : "Provider wait already outstanding",
        )
      );
    }
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    cancelWait = rejectAbort;
    const onAbort = (): void => {
      rejectAbort(providerSignal.reason);
    };
    providerSignal.addEventListener("abort", onAbort, { once: true });
    arm();
    try {
      // A fresh race per demand releases listeners on settlement. Abandoned
      // provider promises remain observed, even when abort is ignored.
      return await Promise.race([pending, aborted]);
    } finally {
      clearTimer();
      providerSignal.removeEventListener("abort", onAbort);
      cancelWait = undefined;
    }
  };

  return {
    providerSignal,
    wait,
    next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
      return wait(Promise.resolve().then(() => iterator.next()));
    },
    pulse(): void {
      if (!disposed && cancelWait && !providerSignal.aborted) arm();
    },
    expired(): boolean {
      return timeout.signal.aborted;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      cancelWait?.(new Error("Idle watchdog disposed"));
    },
  };
}
