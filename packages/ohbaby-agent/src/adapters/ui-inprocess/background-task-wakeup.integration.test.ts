import { afterEach, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createDatabaseRunLedger } from "../../runtime/run-ledger/index.js";
import { DatabaseCurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import { createRunInputCoordinator } from "../../runtime/prompt-scheduler/run-input-coordinator.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { DatabaseShellJobStore } from "../../shell-jobs/store.js";
import { shellJobFixture } from "../../shell-jobs/fixtures/shell-job.js";
import {
  backgroundTaskOpening,
  createBackgroundTaskInputSource,
} from "../ui-runtime/background-task-inputs.js";
import { SessionExecutionGate } from "../session-execution.js";
import { createBackgroundTaskWakeup } from "./background-task-wakeup.js";

afterEach(() => {
  closeDatabase();
});
it("releases a lost admission race and a later user run consumes the same frozen result once", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
  ).run();
  const ledger = createDatabaseRunLedger({ db });
  const inputs = new DatabaseCurrentRunInputStore({ db });
  const messages = createMessageManager({
    bus: createBus(),
    store: createDatabaseMessageStore({ db }),
  });
  const store = new DatabaseShellJobStore({ db });
  await store.insert(
    shellJobFixture({
      sessionId: "s",
      rootSessionId: "s",
      status: "completed",
      resultReadyAt: 1,
      noticeState: "pending",
      cleanup: "confirmed",
      settledAt: 1,
      outputTail: "race result",
    }),
  );
  const options = {
    store,
    isClosed: () => false,
    inputs,
    runs: ledger,
    gate: new SessionExecutionGate(),
    goals: { peekSnapshot: () => undefined },
    reserveRunId: () => Promise.resolve("wake"),
    withSessionControl: async (_id: string, work: () => Promise<unknown>) =>
      work(),
    prepareSession: () => Promise.resolve({}),
    hasUnknownActiveGoal: () => Promise.resolve(false),
    isGoalOwnedHere: () => Promise.resolve(true),
    submit: async () => {
      await ledger.claimPendingRun({
        runId: "foreign",
        sessionId: "s",
        triggerSource: "user",
      });
      await ledger.claimPendingRun({
        runId: "wake",
        sessionId: "s",
        triggerSource: "background-task",
      });
      return undefined;
    },
    runGoalTurn: vi.fn(),
    finishGoalTurn: vi.fn(),
    goalHasRunningSubagents: vi.fn(),
    onReleased: vi.fn(),
    onError: vi.fn(),
  } as unknown as Parameters<typeof createBackgroundTaskWakeup>[0];
  expect(await createBackgroundTaskWakeup(options)("s")).toBe(true);
  await vi.waitFor(() => {
    expect(options.onReleased).toHaveBeenCalled();
  });
  const row = store.get("job");
  expect(row?.noticeWakeRunId).toBeNull();
  if (!row?.noticeBatchId) throw new Error("missing frozen batch");
  const opening = backgroundTaskOpening(store, row.noticeBatchId);
  await ledger.markRunning("foreign");
  await ledger.markSucceeded("foreign");
  await ledger.claimPendingRun({
    runId: "user",
    sessionId: "s",
    triggerSource: "user",
  });
  await ledger.markRunning("user");
  const port = (runId: string) =>
    createRunInputCoordinator({
      runId,
      inputs,
      sources: [
        createBackgroundTaskInputSource({
          store,
          inputs,
          identity: { sessionId: "s", contextScopeId: null, runId },
        }),
      ],
    });
  const delivered = await port("user").beforeStep();
  expect(delivered).toHaveLength(1);
  const text = delivered[0].parts.find((part) => part.type === "text");
  expect(text?.text).toBe(opening.body);
  expect(delivered[0].info.runtimeInput?.sourceId).toBe(opening.sourceId);
  await messages.createMessage({
    id: "answer",
    sessionId: "s",
    runId: "user",
    role: "assistant",
    agent: "default",
  });
  const request = {
    requestId: "answer",
    messageId: "answer",
    runId: "user",
    purpose: "agent-step" as const,
    step: 1,
    attempt: 1,
    startedAt: 1,
    outcome: "running" as const,
    inputIds: [delivered[0].info.runtimeInput?.inputId ?? ""],
  };
  await inputs.admitRequestAttempt(request);
  await messages.updateMessage("answer", {
    modelRequests: [{ ...request, outcome: "success", endedAt: 2 }],
  });
  await inputs.close("user", "done");
  await ledger.markSucceeded("user");
  await ledger.claimPendingRun({
    runId: "later",
    sessionId: "s",
    triggerSource: "user",
  });
  await ledger.markRunning("later");
  expect(await port("later").beforeStep()).toEqual([]);
});

it("admits a matching wake through the real Goal ticket and records its background trigger", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
  ).run();
  const { GoalService, InMemoryGoalPersistence } =
    await import("../../goals/index.js");
  const goals = new GoalService({
    persistence: new InMemoryGoalPersistence(),
    executionControl: { interruptGoalExecution: () => Promise.resolve() },
  });
  const goal = await goals.createGoal("s", {
    actor: "user",
    objective: "finish the task",
  });
  const ledger = createDatabaseRunLedger({ db });
  const inputs = new DatabaseCurrentRunInputStore({ db });
  const store = new DatabaseShellJobStore({ db });
  await store.insert(
    shellJobFixture({
      sessionId: "s",
      rootSessionId: "s",
      goalId: goal.goalId,
      status: "completed",
      resultReadyAt: 1,
      noticeState: "pending",
      cleanup: "confirmed",
      settledAt: 1,
      outputTail: "goal result",
    }),
  );
  let body = "";
  const options = {
    store,
    isClosed: () => false,
    inputs,
    runs: ledger,
    gate: new SessionExecutionGate(),
    goals,
    reserveRunId: () => Promise.resolve("goal-wake"),
    withSessionControl: async (_id: string, work: () => Promise<unknown>) =>
      work(),
    prepareSession: () => Promise.resolve({}),
    hasUnknownActiveGoal: () => Promise.resolve(false),
    isGoalOwnedHere: () => Promise.resolve(true),
    submit: vi.fn(),
    runGoalTurn: async (
      _id: string,
      ticket: import("../../goals/index.js").GoalTurnTicket,
      input: import("./background-task-wakeup.js").BackgroundWakeSubmission,
    ) => {
      goals.bindTicketRun(ticket, input.reservedRunId);
      await ledger.claimPendingRun({
        runId: input.reservedRunId,
        sessionId: "s",
        triggerSource: "background-task",
      });
      await ledger.markRunning(input.reservedRunId);
      body = input.runtimeInput.body;
      await ledger.markSucceeded(input.reservedRunId);
      return { status: "succeeded" as const };
    },
    finishGoalTurn: (
      id: string,
      ticket: import("../../goals/index.js").GoalTurnTicket,
      outcome: import("../../goals/index.js").GoalTurnOutcome,
    ) => goals.settleTurn(id, ticket, outcome),
    goalHasRunningSubagents: () => Promise.resolve(false),
    onReleased: vi.fn(),
    onError: vi.fn(),
  } as unknown as Parameters<typeof createBackgroundTaskWakeup>[0];
  try {
    expect(await createBackgroundTaskWakeup(options)("s")).toBe(true);
    await vi.waitFor(() => {
      expect(options.onReleased).toHaveBeenCalledOnce();
    });
    expect((await ledger.get("goal-wake"))?.triggerSource).toBe(
      "background-task",
    );
    expect(goals.peekSnapshot("s")?.turnsUsed).toBe(1);
    expect(body).toContain("goal result");
    expect(body).not.toContain("finish the task");
  } finally {
    goals.dispose();
  }
});

it("persists Goal guidance separately without changing the frozen batch body", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
  ).run();
  const ledger = createDatabaseRunLedger({ db });
  await ledger.claimPendingRun({
    sessionId: "s",
    runId: "goal-run",
    triggerSource: "background-task",
  });
  await ledger.markRunning("goal-run");
  const inputs = new DatabaseCurrentRunInputStore({ db });
  const { acceptRuntimeOpening } =
    await import("../ui-runtime/runtime-opening.js");
  await acceptRuntimeOpening({
    store: inputs,
    runId: "goal-run",
    sessionId: "s",
    agentName: "default",
    now: 10,
    opening: {
      kind: "background-task-result",
      sourceId: "background-task:batch",
      body: "frozen result",
      goalReminder: "goal instruction",
    },
  });
  const messages = await inputs.getMessages("goal-run");
  expect(messages).toHaveLength(2);
  expect(
    messages.map((message) => message.info.runtimeInput?.sourceId),
  ).toEqual(["goal-reminder:goal-run", "background-task:batch"]);
  expect(
    messages.map(
      (message) => message.parts.find((part) => part.type === "text")?.text,
    ),
  ).toEqual(["goal instruction", "frozen result"]);
});
