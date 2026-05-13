import { describe, expect, it } from "vitest";
import {
  createInMemoryRunLedger,
  InvalidRunTransitionError,
  RunLedgerNotFoundError,
  type RunLedger,
} from "./index.js";

function createClock(startAt = 1_000): () => number {
  let current = startAt;

  return () => {
    const value = current;
    current += 1_000;
    return value;
  };
}

function createLedger(startAt?: number): RunLedger {
  return createInMemoryRunLedger({ now: createClock(startAt) });
}

describe("InMemoryRunLedger", () => {
  it("creates pending records with immutable snapshots", async () => {
    const ledger = createLedger();

    const created = await ledger.createPending({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
    });

    expect(created).toEqual({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
      status: "pending",
      createdAt: 1_000,
    });

    const writable = created as { status: string };
    writable.status = "failed";

    await expect(ledger.get("run_1")).resolves.toEqual({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
      status: "pending",
      createdAt: 1_000,
    });
  });

  it("records a successful lifecycle in order", async () => {
    const ledger = createLedger();
    await ledger.createPending({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "scheduler",
    });

    await expect(ledger.markRunning("run_1")).resolves.toMatchObject({
      runId: "run_1",
      status: "running",
      startedAt: 2_000,
      endedAt: undefined,
    });
    await expect(ledger.markSucceeded("run_1")).resolves.toMatchObject({
      runId: "run_1",
      status: "succeeded",
      startedAt: 2_000,
      endedAt: 3_000,
    });
  });

  it("records failed and cancelled terminal states with reasons", async () => {
    const ledger = createLedger();

    await ledger.createPending({
      runId: "failed_run",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("failed_run");

    await expect(
      ledger.markFailed("failed_run", new Error("tool exploded")),
    ).resolves.toMatchObject({
      runId: "failed_run",
      status: "failed",
      error: "tool exploded",
      endedAt: 3_000,
    });

    await ledger.createPending({
      runId: "cancelled_run",
      sessionId: "session_1",
      triggerSource: "heartbeat",
    });

    await expect(
      ledger.markCancelled("cancelled_run", "user requested stop"),
    ).resolves.toMatchObject({
      runId: "cancelled_run",
      status: "cancelled",
      error: "user requested stop",
      endedAt: 5_000,
    });
  });

  it("rejects duplicate run ids, missing records, and invalid transitions", async () => {
    const ledger = createLedger();
    await ledger.createPending({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(
      ledger.createPending({
        runId: "run_1",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(InvalidRunTransitionError);

    await expect(ledger.markSucceeded("missing_run")).rejects.toBeInstanceOf(
      RunLedgerNotFoundError,
    );

    await ledger.markRunning("run_1");
    await ledger.markSucceeded("run_1");

    await expect(ledger.markRunning("run_1")).rejects.toBeInstanceOf(
      InvalidRunTransitionError,
    );
    await expect(ledger.get("run_1")).resolves.toMatchObject({
      status: "succeeded",
      startedAt: 2_000,
    });
  });

  it("marks pending and running records interrupted idempotently", async () => {
    const ledger = createLedger();
    await ledger.createPending({
      runId: "pending_run",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.createPending({
      runId: "running_run",
      sessionId: "session_1",
      triggerSource: "channel",
    });
    await ledger.markRunning("running_run");
    await ledger.createPending({
      runId: "done_run",
      sessionId: "session_1",
      triggerSource: "follow-up",
    });
    await ledger.markRunning("done_run");
    await ledger.markSucceeded("done_run");

    await expect(ledger.markInterrupted()).resolves.toEqual({
      updatedCount: 2,
    });
    await expect(ledger.markInterrupted()).resolves.toEqual({
      updatedCount: 0,
    });

    await expect(ledger.get("pending_run")).resolves.toMatchObject({
      status: "interrupted",
      error: "process interrupted before run completed",
    });
    await expect(ledger.get("running_run")).resolves.toMatchObject({
      status: "interrupted",
      error: "process interrupted before run completed",
    });
    await expect(ledger.get("done_run")).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("filters active runs and lists session history newest first", async () => {
    const ledger = createLedger();
    await ledger.createPending({
      runId: "old_done",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("old_done");
    await ledger.markSucceeded("old_done");
    await ledger.createPending({
      runId: "active_pending",
      sessionId: "session_1",
      triggerSource: "scheduler",
    });
    await ledger.createPending({
      runId: "other_session",
      sessionId: "session_2",
      triggerSource: "heartbeat",
    });
    await ledger.markRunning("other_session");
    await ledger.createPending({
      runId: "new_pending",
      sessionId: "session_1",
      triggerSource: "channel",
    });

    await expect(ledger.getActiveRuns()).resolves.toMatchObject([
      { runId: "active_pending" },
      { runId: "other_session" },
      { runId: "new_pending" },
    ]);
    await expect(ledger.getActiveRuns("session_1")).resolves.toMatchObject([
      { runId: "active_pending" },
      { runId: "new_pending" },
    ]);
    await expect(
      ledger.listBySession("session_1", { limit: 2 }),
    ).resolves.toMatchObject([
      { runId: "new_pending" },
      { runId: "active_pending" },
    ]);
  });
});
