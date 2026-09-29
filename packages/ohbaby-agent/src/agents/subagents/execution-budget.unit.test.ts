import { afterEach, expect, it, vi } from "vitest";
import { createApprovalAwareDeadline } from "./execution-budget.js";
afterEach(() => {
  vi.useRealTimers();
});
it("pauses only approval time, preserves remaining quota, and resumes without replenishment", async () => {
  vi.useFakeTimers();
  let paused = false;
  let wake = (): void => undefined;
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 100,
    reason: "quota",
    isApprovalBlocked: () => Promise.resolve(paused),
    subscribe: (listener) => {
      wake = listener;
      return () => {
        wake = () => undefined;
      };
    },
    checkIntervalMs: 5,
  });
  await vi.advanceTimersByTimeAsync(30);
  paused = true;
  wake();
  await vi.advanceTimersByTimeAsync(500);
  expect(deadline.didTimeout()).toBe(false);
  paused = false;
  wake();
  await vi.advanceTimersByTimeAsync(40);
  paused = true;
  wake();
  await vi.advanceTimersByTimeAsync(100);
  paused = false;
  wake();
  await vi.advanceTimersByTimeAsync(29);
  expect(deadline.didTimeout()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(deadline.didTimeout()).toBe(true);
  expect(deadline.signal.reason).toBe("quota");
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels a held check and all timers when the original parent stops", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 1000,
    reason: "quota",
    parent: parent.signal,
    isApprovalBlocked: () => new Promise(() => undefined),
  });
  parent.abort("stop");
  await vi.advanceTimersByTimeAsync(1);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.didTimeout()).toBe(false);
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("accounts 10 active minutes, 40 approval minutes, then 5 active minutes against the production quota", async () => {
  vi.useFakeTimers();
  const minute = 60_000;
  let blocked = false;
  let wake = (): void => undefined;
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 30 * minute,
    reason: "quota",
    isApprovalBlocked: () => Promise.resolve(blocked),
    subscribe: (listener) => {
      wake = listener;
      return () => undefined;
    },
  });
  await vi.advanceTimersByTimeAsync(10 * minute);
  blocked = true;
  wake();
  await vi.advanceTimersByTimeAsync(40 * minute);
  blocked = false;
  wake();
  await vi.advanceTimersByTimeAsync(5 * minute);
  expect(deadline.snapshot()).toEqual({
    elapsedMs: 55 * minute,
    activeMs: 15 * minute,
    remainingMs: 15 * minute,
    approvalWaitMs: 40 * minute,
  });
  expect(deadline.didTimeout()).toBe(false);
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("reports unavailable approval facts after bounded retries instead of pausing forever", async () => {
  vi.useFakeTimers();
  const failures: unknown[] = [];
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 1000,
    reason: "quota",
    checkIntervalMs: 5,
    checkTimeoutMs: 5,
    isApprovalBlocked: () => new Promise(() => undefined),
    onFailure: (error) => {
      failures.push(error);
    },
  });
  await vi.advanceTimersByTimeAsync(30);
  expect(failures).toHaveLength(1);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.didTimeout()).toBe(false);
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("charges time after an approval-change wake while the new query is held", async () => {
  vi.useFakeTimers();
  let wake = (): void => undefined;
  let initial = true;
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 30,
    reason: "quota",
    isApprovalBlocked: () =>
      initial
        ? Promise.resolve(true)
        : new Promise((resolve) => {
            setTimeout(() => {
              resolve(false);
            }, 70);
          }),
    subscribe: (listener) => {
      wake = listener;
      return () => undefined;
    },
    checkIntervalMs: 1000,
  });
  await vi.advanceTimersByTimeAsync(0);
  initial = false;
  wake();
  await vi.advanceTimersByTimeAsync(30);
  expect(deadline.didTimeout()).toBe(true);
  deadline.dispose();
});

it("does not let an old approval check re-pause time after a newer change", async () => {
  vi.useFakeTimers();
  let wake = (): void => undefined;
  let calls = 0;
  let oldResult!: (value: boolean) => void;
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 30,
    reason: "quota",
    checkIntervalMs: 5,
    subscribe: (listener) => {
      wake = listener;
      return () => undefined;
    },
    isApprovalBlocked: () => {
      calls++;
      if (calls === 1) return Promise.resolve(true);
      if (calls === 2)
        return new Promise((resolve) => {
          oldResult = resolve;
        });
      return new Promise(() => undefined);
    },
  });
  await vi.advanceTimersByTimeAsync(5);
  wake();
  oldResult(true);
  await vi.advanceTimersByTimeAsync(30);
  expect(deadline.didTimeout()).toBe(true);
  deadline.dispose();
});
it("reports elapsed, active and approval time separately and freezes a finished quota", async () => {
  vi.useFakeTimers();
  let paused = false;
  let wake = (): void => undefined;
  const deadline = createApprovalAwareDeadline({
    timeoutMs: 100,
    reason: "quota",
    checkIntervalMs: 5,
    subscribe: (listener) => {
      wake = listener;
      return () => undefined;
    },
    isApprovalBlocked: () => Promise.resolve(paused),
  });
  await vi.advanceTimersByTimeAsync(30);
  paused = true;
  wake();
  await vi.advanceTimersByTimeAsync(50);
  expect(deadline.snapshot()).toEqual({
    elapsedMs: 80,
    activeMs: 30,
    remainingMs: 70,
    approvalWaitMs: 50,
  });
  deadline.dispose();
  await vi.advanceTimersByTimeAsync(500);
  expect(deadline.snapshot()).toEqual({
    elapsedMs: 80,
    activeMs: 30,
    remainingMs: 70,
    approvalWaitMs: 50,
  });
});
