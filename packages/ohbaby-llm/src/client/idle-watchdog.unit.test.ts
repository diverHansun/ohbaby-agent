/* eslint-disable @typescript-eslint/require-await -- Fake adapters return controlled promises without external I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import {
  createIdleWatchdog,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ProviderStreamIdleTimeoutError,
} from "./idle-watchdog.js";
import { isRetryableProviderError, retryReason } from "./retry.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

describe("provider idle watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each([100, DEFAULT_STREAM_IDLE_TIMEOUT_MS])(
    "bounds an uncooperative wait at %i ms without aborting the caller",
    async (timeoutMs) => {
      const caller = new AbortController();
      const watchdog = createIdleWatchdog({ signal: caller.signal, timeoutMs });
      const result = watchdog
        .wait(
          new Promise<never>(() => {
            /* provider ignores cancellation */
          }),
        )
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(watchdog.expired()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeInstanceOf(ProviderStreamIdleTimeoutError);
      expect(await result).toMatchObject({ timeoutMs, idleMs: timeoutMs });
      expect(watchdog.providerSignal.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(isRetryableProviderError(await result)).toBe(true);
      expect(retryReason(await result)).toBe("stream_idle_timeout");
      watchdog.dispose();
    },
  );

  it("counts only outstanding demand, and raw activity resets its interval", async () => {
    const watchdog = createIdleWatchdog({ signal: undefined, timeoutMs: 100 });
    const pending = deferred<number>();
    const result = watchdog.wait(pending.promise);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(90);
      watchdog.pulse();
    }
    pending.resolve(7);
    expect(await result).toBe(7);
    watchdog.pulse();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.expired()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const next = watchdog.next({
      next: async () => ({ done: true, value: undefined }),
    });
    expect(await next).toEqual({ done: true, value: undefined });
    watchdog.dispose();
  });

  it.each(["resolve", "reject"] as const)(
    "consumes a late %s after expiry",
    async (settle) => {
      const watchdog = createIdleWatchdog({
        signal: undefined,
        timeoutMs: 100,
      });
      const pending = deferred<IteratorResult<string>>();
      const result = watchdog
        .next({ next: () => pending.promise })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBeInstanceOf(ProviderStreamIdleTimeoutError);
      watchdog.dispose();
      if (settle === "resolve") pending.resolve({ done: false, value: "late" });
      else pending.reject(new Error("late"));
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("forwards caller abort immediately even if next ignores it", async () => {
    const caller = new AbortController();
    const watchdog = createIdleWatchdog({
      signal: caller.signal,
      timeoutMs: 100,
    });
    const result = watchdog
      .next({
        next: () =>
          new Promise<never>(() => {
            /* provider ignores cancellation */
          }),
      })
      .catch((e: unknown) => e);
    const reason = new Error("stop");
    caller.abort(reason);
    expect(await result).toBe(reason);
    expect(watchdog.providerSignal.reason).toBe(reason);
    expect(watchdog.expired()).toBe(false);
    watchdog.dispose();
  });

  it("cleans up rejected and synchronously throwing next calls", async () => {
    const watchdog = createIdleWatchdog({ signal: undefined, timeoutMs: 100 });
    const error = new Error("broken next");
    await expect(
      watchdog.next({
        next: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    await expect(watchdog.wait(Promise.reject(error))).rejects.toBe(error);
    watchdog.dispose();
    watchdog.dispose();
  });

  it("releases abort listeners between demands and on disposal", async () => {
    const watchdog = createIdleWatchdog({ signal: undefined, timeoutMs: 100 });
    for (let i = 0; i < 20; i++) {
      const pending = deferred<number>();
      const result = watchdog.wait(pending.promise);
      expect(getEventListeners(watchdog.providerSignal, "abort")).toHaveLength(
        1,
      );
      pending.resolve(i);
      expect(await result).toBe(i);
      expect(getEventListeners(watchdog.providerSignal, "abort")).toHaveLength(
        0,
      );
    }
    const pending = deferred<never>();
    const result = watchdog
      .wait(pending.promise)
      .catch((error: unknown) => error);
    watchdog.dispose();
    expect(await result).toBeInstanceOf(Error);
    expect(getEventListeners(watchdog.providerSignal, "abort")).toHaveLength(0);
  });

  it.each([0, -1, NaN, Infinity, 2_147_483_648])(
    "rejects invalid timeout %s",
    (timeoutMs) => {
      expect(() =>
        createIdleWatchdog({ signal: undefined, timeoutMs }),
      ).toThrow(RangeError);
    },
  );
});
