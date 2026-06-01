import path from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock } from "./file-locks.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("withFileLock", () => {
  it("rejects stalled operations after a bounded timeout and releases the queue", async () => {
    const lockPath = path.join(
      "tmp",
      `ohbaby-lock-timeout-${String(Date.now())}.txt`,
    );
    const starts: string[] = [];

    await expect(
      withFileLock(
        lockPath,
        async () => {
          starts.push("first");
          await delay(25);
          return "first";
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow("File lock timed out");

    await expect(
      withFileLock(
        lockPath,
        async () => {
          await Promise.resolve();
          starts.push("second");
          return "second";
        },
        { timeoutMs: 50 },
      ),
    ).resolves.toBe("second");
    expect(starts).toEqual(["first", "second"]);
  });

  it("serializes operations for the same path", async () => {
    const lockPath = path.join(
      "tmp",
      `ohbaby-lock-order-${String(Date.now())}.txt`,
    );
    const order: string[] = [];
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(
      lockPath,
      async () => {
        order.push("first-start");
        firstStarted();
        await releaseFirstPromise;
        order.push("first-end");
        return "first";
      },
      { timeoutMs: 1000 },
    );
    await firstStartedPromise;
    const second = withFileLock(
      lockPath,
      async () => {
        await Promise.resolve();
        order.push("second");
        return "second";
      },
      { timeoutMs: 1000 },
    );

    await delay(5);
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second"]);
    await expect(
      withFileLock(
        lockPath,
        async () => {
          await Promise.resolve();
          return "third";
        },
        { timeoutMs: 50 },
      ),
    ).resolves.toBe("third");
  });
});
