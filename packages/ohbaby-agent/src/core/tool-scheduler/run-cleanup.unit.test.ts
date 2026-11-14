import { describe, expect, it } from "vitest";
import { RunCleanupTracker } from "./run-cleanup.js";

describe("execution cleanup ownership", () => {
  it("distinguishes a healthy tool from its pending environment release", async () => {
    const tracker = new RunCleanupTracker();
    const tool = tracker.begin("release");
    expect(tracker.snapshot().cleaning).toBe(false);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    tool.settle(() => pending);
    const waiting = tracker.snapshot();
    expect(waiting.cleaning).toBe(true);
    release();
    await waiting.settled;
    expect(tracker.snapshot()).toEqual({ confirmed: true });
  });

  it("holds the original run through raw settlement, resource release and late process evidence", async () => {
    const tracker = new RunCleanupTracker();
    const first = tracker.begin("one");
    const sibling = tracker.begin("two");
    expect(tracker.snapshot().cleaning).toBe(false);
    first.report("in-progress");
    expect(tracker.snapshot().cleaning).toBe(true);
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
    expect(waiting.cleaning).toBe(true);
    await Promise.resolve();
    release();
    await Promise.resolve();
    expect(tracker.snapshot("one").confirmed).toBe(false);
    first.report("confirmed");
    await waiting.settled;
    expect(tracker.snapshot("one")).toEqual({ confirmed: true });
    expect(tracker.snapshot("two").confirmed).toBe(false);
    expect(tracker.snapshot().cleaning).toBe(false);
    sibling.settle();
    expect(tracker.snapshot("two").confirmed).toBe(true);
  });
});
