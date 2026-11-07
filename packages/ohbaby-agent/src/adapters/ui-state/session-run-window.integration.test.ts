import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  UiPromptSubmission,
  UiRun,
  UiSession,
  UiSnapshot,
} from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createDatabaseRunLedger } from "../../runtime/run-ledger/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { createInProcessUiBackendClient } from "../ui-inprocess.js";
import { runToUiRun } from "./persistent-store.js";
import { SourceSessionProjection } from "./source-session-projection.js";

const sessionId = "session";
const metadata: Omit<UiSession, "messages"> = {
  id: sessionId,
  title: "Run history",
  createdAt: "2026",
  updatedAt: "2026",
};
const snapshot: UiSnapshot = {
  activeSessionId: sessionId,
  sessions: [{ ...metadata, messages: [] }],
  runs: [],
  permissions: [],
  status: { kind: "idle" },
};
beforeEach(() => {
  initDatabase({ dbPath: ":memory:" });
  getDatabase()
    .prepare(
      `INSERT INTO session
    (id, project_id, working_directory, agent, title, status, created_at, updated_at, message_count, data)
    VALUES (?, 'project', '/test', 'default', 'Run history', 'active', 1, 1, 0, '{}')`,
    )
    .run(sessionId);
});
afterEach(closeDatabase);

it("loads the latest main run in full and returns only the main runs of each history page", async () => {
  let clock = 0;
  const ledger = createDatabaseRunLedger({ now: () => ++clock });
  const store = createDatabaseMessageStore();
  for (let i = 1; i <= 60; i++) {
    const runId = `main-${String(i)}`;
    await ledger.createPending({ sessionId, runId, triggerSource: "subagent" });
    await ledger.markRunning(runId);
    await ledger.markSucceeded(runId);
    // The latest run's early message falls outside the first page.
    await store.insertMessage({
      id: `msg-${String(i)}`,
      agent: "default",
      role: "assistant",
      sessionId,
      runId,
      time: { created: i === 60 ? 0 : i, completed: 100 },
    });
  }
  for (let i = 0; i < 55; i++) {
    await ledger.createPending({
      sessionId,
      runId: `child-${String(i)}`,
      triggerSource: "user",
      contextScopeId: `child-${String(i)}`,
    });
  }
  const client = createInProcessUiBackendClient({
    initialSnapshot: snapshot,
    runLedger: ledger,
    messageManager: createMessageManager({ store, bus: createBus() }),
  });
  try {
    const view = await client.getSessionView({ sessionId });
    expect(view.runs.map((run) => run.id)).toEqual(
      Array.from({ length: 51 }, (_, i) => `main-${String(60 - i)}`),
    );
    expect(view.session.messages.map((message) => message.runId)).toContain(
      "main-60",
    );
    const history = await client.getSessionHistory({
      sessionId,
      before: view.history.before,
      limit: 5,
    });
    expect(history.runs.map((run) => run.id)).toEqual([
      "main-9",
      "main-8",
      "main-7",
      "main-6",
      "main-5",
    ]);
    expect(
      history.runs.every(
        (run) => run.trigger === "subagent" && run.outcome === "succeeded",
      ),
    ).toBe(true);
    expect(new Set(history.runs.map((run) => run.id))).toEqual(
      new Set(history.messages.map((message) => message.runId)),
    );
  } finally {
    await client.dispose();
  }
});

it("returns snapshot-only and ledger runs together, preferring the ledger for a shared ID", async () => {
  const ledger = createDatabaseRunLedger({ now: () => 200 });
  await ledger.createPending({
    sessionId,
    runId: "new",
    triggerSource: "subagent",
  });
  await ledger.markRunning("new");
  await ledger.markSucceeded("new");
  const store = createDatabaseMessageStore();
  for (const [i, runId] of ["old", "new"].entries()) {
    await store.insertMessage({
      id: `reply-${runId}`,
      sessionId,
      runId,
      role: "assistant",
      agent: "default",
      time: { created: i + 1, completed: 200 },
    });
  }
  const old: UiRun = {
    id: "old",
    sessionId,
    startedAt: new Date(100).toISOString(),
    updatedAt: new Date(150).toISOString(),
    status: { kind: "idle" },
    trigger: "goal",
  };
  const client = createInProcessUiBackendClient({
    initialSnapshot: { ...snapshot, runs: [old, { ...old, id: "new" }] },
    runLedger: ledger,
    messageManager: createMessageManager({ store, bus: createBus() }),
  });
  try {
    const view = await client.getSessionView({ sessionId });
    const history = await client.getSessionHistory({ sessionId });
    for (const runs of [view.runs, history.runs])
      expect(runs).toMatchObject([
        { id: "new", outcome: "succeeded", trigger: "subagent" },
        { id: "old", trigger: "goal" },
      ]);
  } finally {
    await client.dispose();
  }
});

it("keeps active runs before their first message, prunes evicted runs and restores metadata for a late message", async () => {
  let clock = 0;
  const ledger = createDatabaseRunLedger({ now: () => ++clock });
  const manager = createMessageManager({
    store: createDatabaseMessageStore(),
    bus: createBus(),
    now: () => ++clock,
  });
  const source = new SourceSessionProjection({
    runtimeEpoch: "epoch",
    messageManager: manager,
    metadata: (): Promise<typeof metadata> => Promise.resolve(metadata),
    runs: async (id, selection): Promise<UiRun[]> =>
      (
        await ledger.listBySession(id, {
          mainOnly: true,
          ...(selection === "current" ? { limit: 1 } : { runIds: selection }),
        })
      ).map(runToUiRun),
    prompts: (): Promise<UiPromptSubmission[]> => Promise.resolve([]),
    publish: (): void => undefined,
  });
  const active = await ledger.createPending({
    sessionId,
    runId: "at-start",
    triggerSource: "goal",
  });
  await source.owner.initialize(sessionId);
  expect(source.owner.read(sessionId).runs.map((run) => run.id)).toEqual([
    active.runId,
  ]);
  const ended = await ledger.markCancelled(active.runId, "user-stop");
  await source.commitEvent({ type: "run.updated", run: runToUiRun(ended) });
  expect(source.owner.read(sessionId).runs).toEqual([]);
  for (let i = 0; i < 51; i++) {
    const runId = `run-${String(i)}`;
    const record = await ledger.createPending({
      sessionId,
      runId,
      triggerSource: "user",
    });
    await source.commitEvent({ type: "run.updated", run: runToUiRun(record) });
    if (i === 50) expect(source.owner.read(sessionId).runs).toHaveLength(51);
    await manager.createMessage({
      agent: "default",
      sessionId,
      runId,
      role: "assistant",
    });
    await ledger.markRunning(runId);
    await source.commitEvent({
      type: "run.updated",
      run: runToUiRun(await ledger.markSucceeded(runId)),
    });
  }
  const visible = source.owner.read(sessionId);
  expect(visible.runs.map((run) => run.id)).toEqual(
    Array.from({ length: 50 }, (_, i) => `run-${String(50 - i)}`),
  );
  expect(
    source.owner.read(sessionId).runs.some((run) => run.id === ended.runId),
  ).toBe(false);
  await manager.createMessage({
    agent: "default",
    sessionId,
    runId: ended.runId,
    role: "assistant",
  });
  expect(
    source.owner.read(sessionId).runs.find((run) => run.id === ended.runId),
  ).toMatchObject({ trigger: "goal", outcome: "cancelled" });
  expect(
    (await source.executionHistory(sessionId, "child-scope", "run-x")).runs,
  ).toEqual([]);
});

it("keeps a run update that lands while a late message looks up its run", async () => {
  let clock = 0;
  const ledger = createDatabaseRunLedger({ now: () => ++clock });
  const manager = createMessageManager({
    store: createDatabaseMessageStore(),
    bus: createBus(),
    now: () => ++clock,
  });
  let release: (() => void) | undefined;
  const source = new SourceSessionProjection({
    runtimeEpoch: "epoch",
    messageManager: manager,
    metadata: (): Promise<typeof metadata> => Promise.resolve(metadata),
    runs: async (id, selection): Promise<UiRun[]> => {
      // Hold the late message's lookup open so a run update can land first.
      if (selection !== "current" && selection.includes("late"))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return (
        await ledger.listBySession(id, {
          mainOnly: true,
          ...(selection === "current" ? { limit: 1 } : { runIds: selection }),
        })
      ).map(runToUiRun);
    },
    prompts: (): Promise<UiPromptSubmission[]> => Promise.resolve([]),
    publish: (): void => undefined,
  });
  await ledger.createPending({
    sessionId,
    runId: "late",
    triggerSource: "subagent",
  });
  await ledger.markRunning("late");
  await ledger.markSucceeded("late");
  await source.owner.initialize(sessionId);
  const committing = manager.createMessage({
    agent: "default",
    sessionId,
    runId: "late",
    role: "assistant",
  });
  await vi.waitFor(() => {
    expect(release).toBeDefined();
  });
  const next = await ledger.createPending({
    sessionId,
    runId: "next",
    triggerSource: "user",
  });
  await source.commitEvent({ type: "run.updated", run: runToUiRun(next) });
  release?.();
  await committing;
  expect(source.owner.read(sessionId).runs.map((run) => run.id)).toEqual([
    "next",
    "late",
  ]);
});
