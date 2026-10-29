import { describe, expect, it } from "vitest";
import { RunCleanupTracker } from "./run-cleanup.js";

describe("execution cleanup ownership", () => {
  it("holds the original run through raw settlement, resource release and late process evidence", async () => {
    const tracker = new RunCleanupTracker();
    const first = tracker.begin("one");
    const sibling = tracker.begin("two");
    first.report("unconfirmed");
    let release!: () => void;
    first.settle(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const waiting = tracker.snapshot("one");
    expect(waiting.confirmed).toBe(false);
    await Promise.resolve();
    release();
    await Promise.resolve();
    expect(tracker.snapshot("one").confirmed).toBe(false);
    first.report("confirmed");
    await waiting.settled;
    expect(tracker.snapshot("one")).toEqual({ confirmed: true });
    expect(tracker.snapshot("two").confirmed).toBe(false);
    sibling.settle();
    expect(tracker.snapshot("two").confirmed).toBe(true);
  });
});
