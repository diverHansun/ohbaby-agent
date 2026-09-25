import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { withFileLock } from "./file-locks.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("withFileLock", () => {
  it.each(["resolve", "reject"] as const)(
    "retains ownership beyond the old deadline until a late %s",
    async (settlement) => {
      vi.useFakeTimers();
      const gate = deferred<string>();
      const started = deferred();
      const order: string[] = [];
      const first = withFileLock("tmp/lock-deadline.txt", () => {
        started.resolve();
        return gate.promise;
      });
      const observed = first.then(
        (value) => value,
        (error: unknown) => error,
      );
      let second: Promise<unknown> | undefined;
      try {
        await started.promise;
        second = withFileLock("tmp/lock-deadline.txt", () => {
          order.push("second");
          return Promise.resolve("second");
        });
        await vi.advanceTimersByTimeAsync(120_001);
        expect(order).toEqual([]);
        await expect(
          withFileLock("tmp/lock-independent.txt", () =>
            Promise.resolve("other"),
          ),
        ).resolves.toBe("other");
        const failure = new Error("late failure");
        if (settlement === "resolve") gate.resolve("first");
        else gate.reject(failure);
        expect(await observed).toBe(
          settlement === "resolve" ? "first" : failure,
        );
        await second;
        expect(order).toEqual(["second"]);
      } finally {
        gate.resolve("cleanup");
        await Promise.allSettled([observed, ...(second ? [second] : [])]);
        vi.useRealTimers();
      }
    },
  );

  it("cancels a waiter promptly without running it or releasing the holder", async () => {
    const gate = deferred();
    const started = deferred();
    const controller = new AbortController();
    const order: string[] = [];
    const first = withFileLock("tmp/lock-cancel.txt", () => {
      started.resolve();
      return gate.promise;
    });
    const pending: Promise<unknown>[] = [first];
    try {
      await started.promise;
      const canceled = withFileLock(
        "tmp/lock-cancel.txt",
        () => {
          order.push("canceled");
          return Promise.resolve();
        },
        { signal: controller.signal },
      );
      const observed = canceled.catch((error: unknown) => error);
      pending.push(observed);
      controller.abort(new Error("stop waiting"));
      // A separate unlocked operation gives the cancellation its microtask turn.
      await withFileLock("tmp/lock-cancel-other.txt", () => Promise.resolve());
      let canceledResult: unknown;
      void observed.then((value) => {
        canceledResult = value;
      });
      await Promise.resolve();
      expect(canceledResult).toEqual(new Error("stop waiting"));
      const successor = withFileLock("tmp/lock-cancel.txt", () => {
        order.push("successor");
        return Promise.resolve();
      });
      pending.push(successor);
      await withFileLock("tmp/lock-cancel-other.txt", () => Promise.resolve());
      expect(order).toEqual([]);
      gate.resolve();
      await Promise.all(pending);
      expect(order).toEqual(["successor"]);
    } finally {
      gate.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("rechecks cancellation when release and abort race, without leaking listeners", async () => {
    const gate = deferred();
    const controller = new AbortController();
    const started = deferred();
    const holder = withFileLock("tmp/lock-grant-race.txt", () => {
      started.resolve();
      return gate.promise;
    });
    let invoked = false;
    const waiter = withFileLock(
      "tmp/lock-grant-race.txt",
      () => {
        invoked = true;
        return Promise.resolve();
      },
      { signal: controller.signal },
    );
    const observed = waiter.catch((error: unknown) => error);
    try {
      await started.promise;
      gate.resolve();
      controller.abort(new Error("grant race"));
      expect(await observed).toEqual(new Error("grant race"));
      await withFileLock("tmp/lock-grant-race.txt", () => Promise.resolve());
      expect(invoked).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    } finally {
      gate.resolve();
      await Promise.allSettled([holder, observed]);
    }
  });

  it("detaches the waiting listener at grant and releases after a synchronous throw", async () => {
    const controller = new AbortController();
    await expect(
      withFileLock(
        "tmp/lock-sync-failure.txt",
        () => {
          expect(getEventListeners(controller.signal, "abort")).toEqual([]);
          throw new Error("sync failure");
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("sync failure");
    await expect(
      withFileLock("tmp/lock-sync-failure.txt", () => Promise.resolve("next")),
    ).resolves.toBe("next");
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("does not invoke an already canceled operation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    let invoked = false;
    await expect(
      withFileLock(
        "tmp/lock-preabort.txt",
        () => {
          invoked = true;
          return Promise.resolve();
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("already stopped");
    expect(invoked).toBe(false);
  });

  it("retains an active canceled holder until settlement and preserves successor ownership", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const controller = new AbortController();
    const order: string[] = [];
    const first = withFileLock(
      "tmp/lock-active-abort.txt",
      () => {
        firstStarted.resolve();
        return firstGate.promise;
      },
      { signal: controller.signal },
    );
    const pending: Promise<unknown>[] = [first];
    try {
      await firstStarted.promise;
      controller.abort();
      const second = withFileLock("tmp/lock-active-abort.txt", () => {
        order.push("second");
        secondStarted.resolve();
        return secondGate.promise;
      });
      pending.push(second);
      await withFileLock("tmp/lock-active-other.txt", () => Promise.resolve());
      expect(order).toEqual([]);
      firstGate.resolve();
      await first;
      await secondStarted.promise;
      const third = withFileLock("tmp/lock-active-abort.txt", () => {
        order.push("third");
        return Promise.resolve();
      });
      pending.push(third);
      await withFileLock("tmp/lock-active-other.txt", () => Promise.resolve());
      expect(order).toEqual(["second"]);
      secondGate.resolve();
      await third;
      expect(order).toEqual(["second", "third"]);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.allSettled(pending);
    }
  });
});
