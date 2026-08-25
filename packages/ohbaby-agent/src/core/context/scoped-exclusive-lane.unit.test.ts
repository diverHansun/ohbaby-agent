import { describe, expect, it } from "vitest";
import { createScopedExclusiveLane } from "./scoped-exclusive-lane.js";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => {
    throw new Error("Deferred resolver was not initialized");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createScopedExclusiveLane", () => {
  it("runs operations with the same key in FIFO order", async () => {
    const lane = createScopedExclusiveLane();
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const order: string[] = [];

    const first = lane.run("scope", async () => {
      order.push("first-start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first-end");
    });
    await firstStarted.promise;
    const second = lane.run("scope", () => {
      order.push("second");
      return Promise.resolve();
    });
    await Promise.resolve();

    expect(order).toEqual(["first-start"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("does not serialize independent keys", async () => {
    const lane = createScopedExclusiveLane();
    const releaseLeft = deferred();
    const leftStarted = deferred();
    const rightStarted = deferred();

    const left = lane.run("left", async () => {
      leftStarted.resolve();
      await releaseLeft.promise;
    });
    await leftStarted.promise;
    const right = lane.run("right", () => {
      rightStarted.resolve();
      return Promise.resolve();
    });

    await rightStarted.promise;
    releaseLeft.resolve();
    await Promise.all([left, right]);
  });

  it("releases the key after an operation rejects", async () => {
    const lane = createScopedExclusiveLane();

    await expect(
      lane.run("scope", () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    await expect(
      lane.run("scope", () => Promise.resolve("recovered")),
    ).resolves.toBe("recovered");
  });
});
