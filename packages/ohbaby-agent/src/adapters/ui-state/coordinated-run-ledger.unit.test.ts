import { describe, expect, it } from "vitest";
import {
  createInMemoryRunLedger,
  type RunLedgerRecord,
} from "../../runtime/run-ledger/index.js";
import { createCoordinatedRunLedger } from "./coordinated-run-ledger.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const input = (
  runId: string,
  sessionId = "session",
): { runId: string; sessionId: string; triggerSource: "user" } => ({
  runId,
  sessionId,
  triggerSource: "user" as const,
});

describe("coordinated run source", () => {
  it("waits for session initialization and commits a durable run before exposing its result", async () => {
    const seed = deferred();
    const source = createInMemoryRunLedger();
    const records: RunLedgerRecord[] = [];
    const ledger = createCoordinatedRunLedger({
      ledger: source,
      coordinator: {
        run: async (_sessionId, operation) => {
          await seed.promise;
          return operation();
        },
        onCommitted: (record) => {
          records.push(record);
        },
        onProjectionError: () => undefined,
      },
    });
    const pending = ledger.createPending(input("run"));
    expect(await source.get("run")).toBeUndefined();
    seed.resolve();
    const result = await pending;
    expect(records).toEqual([result]);
    expect(await source.get("run")).toEqual(result);
  });
  it("serializes each session through database plus commit while other sessions proceed", async () => {
    const source = createInMemoryRunLedger();
    const blocked = deferred();
    const written = deferred();
    const tails = new Map<string, Promise<unknown>>();
    const seen: string[] = [];
    const ledger = createCoordinatedRunLedger({
      ledger: {
        ...source,
        createPending: async (value) => {
          const record = await source.createPending(value);
          if (value.runId === "a") {
            written.resolve();
            await blocked.promise;
          }
          return record;
        },
        claimPendingRun: source.claimPendingRun.bind(source),
        markRunning: source.markRunning.bind(source),
        markSucceeded: source.markSucceeded.bind(source),
        markFailed: source.markFailed.bind(source),
        markCancelled: source.markCancelled.bind(source),
        markInterrupted: source.markInterrupted.bind(source),
        recoverOrphanedRuns: source.recoverOrphanedRuns.bind(source),
        get: source.get.bind(source),
        listBySession: source.listBySession.bind(source),
        getActiveRuns: source.getActiveRuns.bind(source),
      },
      coordinator: {
        run: (sessionId, operation) => {
          const pending = (tails.get(sessionId) ?? Promise.resolve()).then(
            operation,
          );
          tails.set(
            sessionId,
            pending.catch(() => undefined),
          );
          return pending;
        },
        onCommitted: (record) => {
          seen.push(`${record.runId}:${record.status}`);
        },
        onProjectionError: () => undefined,
      },
    });
    const first = ledger.createPending(input("a"));
    await written.promise;
    const second = ledger.markRunning("a");
    await ledger.createPending(input("b", "other"));
    expect(seen).toEqual(["b:pending"]);
    blocked.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual(["b:pending", "a:pending", "a:running"]);
  });
  it("does not turn a projection failure into a repeated or failed business mutation", async () => {
    const source = createInMemoryRunLedger();
    const errors: string[] = [];
    const ledger = createCoordinatedRunLedger({
      ledger: source,
      coordinator: {
        run: (_id, operation) => operation(),
        onCommitted: () => {
          throw new Error("projection");
        },
        onProjectionError: (sessionId) => {
          errors.push(sessionId);
        },
      },
    });
    await ledger.createPending(input("run"));
    await ledger.markRunning("run");
    await expect(ledger.markSucceeded("run")).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(await source.listBySession("session")).toHaveLength(1);
    expect(errors).toEqual(["session", "session", "session"]);
  });
  it("accepts orphan transitions made by claim before its new run", async () => {
    const source = createInMemoryRunLedger({ isOwnerAlive: () => false });
    await source.createPending({ ...input("orphan"), ownerPid: 123 });
    const seen: string[] = [];
    const ledger = createCoordinatedRunLedger({
      ledger: source,
      coordinator: {
        run: (_id, operation) => operation(),
        onCommitted: (record) => {
          seen.push(`${record.runId}:${record.status}`);
        },
        onProjectionError: () => undefined,
      },
    });
    await ledger.claimPendingRun(input("new"));
    expect(seen).toEqual(["orphan:interrupted", "new:pending"]);
  });
  it("keeps read queries and explicit startup recovery independent from view initialization", async () => {
    const source = createInMemoryRunLedger({ isOwnerAlive: () => false });
    await source.createPending({
      ...input("old"),
      ownerId: "dead",
      ownerPid: 2147483647,
    });
    const ledger = createCoordinatedRunLedger({
      ledger: source,
      coordinator: {
        run: () => {
          throw new Error("must not initialize a view");
        },
        onCommitted: () => {
          throw new Error("startup has no view");
        },
        onProjectionError: () => undefined,
      },
    });
    expect(await ledger.recoverOrphanedRuns()).toEqual({ updatedCount: 1 });
    expect((await ledger.get("old"))?.status).toBe("interrupted");
    expect(await ledger.getActiveRuns()).toEqual([]);
    expect(await ledger.listBySession("session")).toHaveLength(1);
  });
});

it("preserves a successful claim when its orphan projection refresh fails", async () => {
  const source = createInMemoryRunLedger({ isOwnerAlive: () => false });
  await source.createPending({ ...input("old"), ownerPid: 999 });
  source.get = (): Promise<RunLedgerRecord | undefined> =>
    Promise.reject(new Error("orphan refresh failed"));
  const errors: string[] = [];
  const ledger = createCoordinatedRunLedger({
    ledger: source,
    coordinator: {
      run: (_id, operation) => operation(),
      onCommitted: () => undefined,
      onProjectionError: (sessionId) => {
        errors.push(sessionId);
      },
    },
  });
  await expect(ledger.claimPendingRun(input("new"))).resolves.toMatchObject({
    status: "pending",
    runId: "new",
  });
  expect(errors).toEqual(["session"]);
});
