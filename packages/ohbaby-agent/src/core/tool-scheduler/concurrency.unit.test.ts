import { describe, expect, it } from "vitest";
import { ConcurrencyController } from "./concurrency.js";
import { DEFAULT_TOOL_SCHEDULER_CONFIG } from "./constants.js";

describe("session execution capacity", () => {
  it("limits ordinary work per session and keeps dispatch/control independent", async () => {
    const controller = new ConcurrencyController(
      DEFAULT_TOOL_SCHEDULER_CONFIG.concurrency,
    );
    const leases = Array.from({ length: 10 }, () =>
      controller.acquire("ordinary", "a"),
    );
    expect(controller.canExecute("ordinary", "a")).toBe(false);
    expect(controller.canExecute("ordinary", "b")).toBe(true);
    expect(controller.canExecute("dispatch", "a")).toBe(true);
    const dispatch = Array.from({ length: 3 }, () =>
      controller.acquire("dispatch", "a"),
    );
    expect(controller.canExecute("dispatch", "a")).toBe(false);
    const control = await controller.waitForSlot("control", "control", "a");
    expect(control).toBeDefined();
    control?.release();
    leases.forEach((lease) => {
      lease.release();
    });
    dispatch.forEach((lease) => {
      lease.release();
    });
    expect(controller.canExecute("ordinary", "a")).toBe(true);
  });

  it("uses legacy limits and explicit ordinary limits without overflow", () => {
    const legacy = new ConcurrencyController({
      maxReadConcurrency: 1,
      maxSubagentConcurrency: 1,
    });
    const current = new ConcurrencyController({
      maxConcurrency: 2,
      maxReadConcurrency: 1,
      maxSubagentConcurrency: 1,
    });
    legacy.acquire("ordinary", "s");
    expect(legacy.canExecute("ordinary", "s")).toBe(false);
    expect(() => legacy.acquire("ordinary", "s")).toThrow();
    current.acquire("ordinary", "s");
    expect(current.canExecute("ordinary", "s")).toBe(true);
    current.acquire("ordinary", "s");
    expect(current.canExecute("ordinary", "s")).toBe(false);
  });

  it("transfers freed slots in FIFO order and duplicate release cannot free the next owner's slot", async () => {
    const controller = new ConcurrencyController({
      maxReadConcurrency: 1,
      maxSubagentConcurrency: 1,
    });
    const initial = controller.acquire("ordinary", "s");
    const order: string[] = [];
    const first = controller
      .waitForSlot("first", "ordinary", "s")
      .then((lease) => {
        order.push("first");
        return lease;
      });
    const second = controller
      .waitForSlot("second", "ordinary", "s")
      .then((lease) => {
        order.push("second");
        return lease;
      });
    const other = await controller.waitForSlot(
      "other",
      "ordinary",
      "other-session",
    );
    expect(other).toBeDefined();
    initial.release();
    const firstLease = await first;
    initial.release();
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    expect(controller.canExecute("ordinary", "s")).toBe(false);
    firstLease?.release();
    const secondLease = await second;
    expect(order).toEqual(["first", "second"]);
    secondLease?.release();
    other?.release();
  });

  it("cancels queued work without returning an occupied slot or cancelling another session", async () => {
    const controller = new ConcurrencyController({
      maxReadConcurrency: 1,
      maxSubagentConcurrency: 1,
    });
    const a = controller.acquire("ordinary", "a");
    const b = controller.acquire("ordinary", "b");
    const cancelled = controller.waitForSlot("cancelled", "ordinary", "a");
    const queued = controller.waitForSlot("queued", "ordinary", "b");
    expect(controller.cancel("cancelled")).toBe(true);
    expect(await cancelled).toBeUndefined();
    expect(controller.cancel("cancelled")).toBe(false);
    expect(controller.canExecute("ordinary", "a")).toBe(false);
    expect(controller.canExecute("ordinary", "b")).toBe(false);
    expect(controller.cancelAll()).toEqual(["queued"]);
    expect(await queued).toBeUndefined();
    expect(controller.canExecute("ordinary", "b")).toBe(false);
    a.release();
    b.release();
  });

  it("notifies admission waiters only once per release and removes listeners", () => {
    const controller = new ConcurrencyController({
      maxReadConcurrency: 1,
      maxSubagentConcurrency: 1,
    });
    const initial = controller.tryAcquire("ordinary", "s");
    expect(initial).toBeDefined();
    expect(controller.tryAcquire("ordinary", "s")).toBeUndefined();
    let notifications = 0;
    const unsubscribe = controller.subscribeAvailability(() => {
      notifications += 1;
    });
    initial?.release();
    initial?.release();
    expect(notifications).toBe(1);
    const next = controller.tryAcquire("ordinary", "s");
    expect(next).toBeDefined();
    unsubscribe();
    next?.release();
    expect(notifications).toBe(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid configured limits: %s",
    (limit) => {
      expect(
        () =>
          new ConcurrencyController({
            maxReadConcurrency: limit,
            maxSubagentConcurrency: 1,
          }),
      ).toThrow();
      expect(
        () =>
          new ConcurrencyController({
            maxConcurrency: limit,
            maxSubagentConcurrency: 1,
          }),
      ).toThrow();
      expect(
        () =>
          new ConcurrencyController({
            maxReadConcurrency: 1,
            maxSubagentConcurrency: limit,
          }),
      ).toThrow();
    },
  );
});
