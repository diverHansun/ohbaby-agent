import { RuntimeSwitchPendingError } from "./runtime-controller.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryShellJobStore } from "../../tools/shell-job-store.js";
import { shellJobFixture } from "../../tools/fixtures/shell-job.js";
import { SessionExecutionGate } from "../session-execution.js";
import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";
import { createBackgroundTaskWakeup } from "./background-task-wakeup.js";

type Options = Parameters<typeof createBackgroundTaskWakeup>[0];
function fixture(overrides: Partial<Options> = {}) {
  const store = new InMemoryShellJobStore();
  const submit = vi.fn().mockResolvedValue({ status: "succeeded" });
  const inputs = {
    listBySource: vi.fn().mockResolvedValue([]),
    reconcileRequestSuccess: vi.fn(),
  };
  const goals = {
    peekSnapshot: vi.fn().mockReturnValue(undefined),
    isAutomaticRunBudgetExhausted: vi.fn().mockReturnValue(false),
    admitTurnInBoundary: vi.fn(),
    currentExecutionEpoch: vi.fn(),
    pauseExecution: vi.fn(),
    isExecutionCurrent: vi.fn(),
    notifyWorkAvailable: vi.fn(),
  };
  const gate = new SessionExecutionGate();
  const opts = {
    store,
    isClosed: () => false,
    inputs: inputs as unknown as Options["inputs"],
    goals: goals as unknown as Options["goals"],
    gate,
    runs: {
      get: vi.fn().mockResolvedValue(undefined),
      getActiveRuns: vi.fn().mockResolvedValue([]),
    },
    reserveRunId: vi.fn().mockResolvedValue("wake"),
    withSessionControl: async (_id: string, work: () => Promise<unknown>) =>
      work(),
    prepareSession: vi.fn().mockResolvedValue({}),
    hasUnknownActiveGoal: vi.fn().mockResolvedValue(false),
    isGoalOwnedHere: vi.fn().mockResolvedValue(true),
    submit,
    runGoalTurn: vi.fn(),
    finishGoalTurn: vi.fn(),
    goalHasRunningSubagents: vi.fn().mockResolvedValue(false),
    onReleased: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  } as unknown as Options;
  return {
    store,
    submit,
    inputs,
    goals,
    gate,
    opts,
    wake: createBackgroundTaskWakeup(opts),
  };
}
async function add(
  store: InMemoryShellJobStore,
  extra: Parameters<typeof shellJobFixture>[0] = {},
) {
  await store.insert(
    shellJobFixture({
      sessionId: "s",
      rootSessionId: "s",
      mode: "background",
      status: "completed",
      cleanup: "confirmed",
      settledAt: 1,
      resultReadyAt: 1,
      noticeState: "pending",
      ...extra,
    }),
  );
}
describe("background result wake admission", () => {
  it("refunds an unstarted Goal wake while settings replacement is pending without pausing", async () => {
    const ticket = { token: Symbol(), goalId: "g", executionEpoch: 1 };
    const finish = vi.fn().mockResolvedValue(undefined);
    const f = fixture({
      runGoalTurn: vi
        .fn()
        .mockRejectedValue(new RuntimeSwitchPendingError("waiting")),
      finishGoalTurn: finish,
    });
    await add(f.store, { goalId: "g" });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.admitTurnInBoundary.mockResolvedValue(ticket);
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(finish).toHaveBeenCalledOnce();
    });
    expect(finish.mock.calls[0]?.[2]).toMatchObject({
      status: "not_admitted",
      refundUnstartedTurn: true,
    });
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
    expect(f.goals.pauseExecution).not.toHaveBeenCalled();
  });

  it("claims and submits a frozen result exactly once after a failed run", async () => {
    const f = fixture();
    await add(f.store);
    f.submit.mockRejectedValue(new Error("network"));
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(f.opts.onError).toHaveBeenCalled();
    });
    expect(await f.wake("s")).toBe(false);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
  });
  it("keeps its single wake claim after a user stops the wake run", async () => {
    const f = fixture();
    await add(f.store);
    f.submit.mockResolvedValue({ status: "cancelled" });
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(f.opts.onReleased).toHaveBeenCalledOnce();
    });
    expect(await f.wake("s")).toBe(false);
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
  });

  it("does not claim while busy, and releases a proven unstarted concurrent admission", async () => {
    const f = fixture();
    await add(f.store);
    const token = Symbol();
    f.gate.reserve("s", token);
    expect(await f.wake("s")).toBe(false);
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
    f.gate.release(token);
    f.submit.mockRejectedValue(new SessionRunBusyError("s", []));
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
    });
  });
  it("keeps a wake claim when a rejected run ID already exists", async () => {
    const f = fixture({
      runs: {
        get: vi.fn().mockResolvedValue({ runId: "wake" }),
        getActiveRuns: vi.fn().mockResolvedValue([]),
      },
    });
    await add(f.store);
    f.submit.mockRejectedValue(new SessionRunBusyError("s", []));
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(f.opts.onError).toHaveBeenCalledOnce();
    });
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
    expect(await f.wake("s")).toBe(false);
  });
  it("releases the local gate if reserving a run ID fails", async () => {
    const f = fixture({
      reserveRunId: vi.fn().mockRejectedValue(new Error("failed")),
    });
    await add(f.store);
    await expect(f.wake("s")).rejects.toThrow("failed");
    expect(f.gate.isHeld("s")).toBe(false);
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
  });

  it("repairs a processed unbound batch without waking again", async () => {
    const f = fixture();
    await add(f.store);
    const batch = await f.store.allocateNoticeBatch({
      sessionId: "s",
      contextScopeId: null,
    });
    f.inputs.listBySource.mockResolvedValue([{ inputId: "old", runId: "old" }]);
    f.inputs.reconcileRequestSuccess.mockResolvedValue({
      inputId: "old",
      processedRequestId: "request",
    });
    expect(await f.wake("s")).toBe(false);
    if (!batch) throw new Error("missing batch");
    expect(f.store.getNoticeBatch(batch)[0]?.noticeState).toBe("accepted");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("repairs a closed but unconsumed accepted input without auto-waking", async () => {
    const f = fixture();
    await add(f.store);
    const batch = await f.store.allocateNoticeBatch({
      sessionId: "s",
      contextScopeId: null,
    });
    f.inputs.listBySource.mockResolvedValue([
      { inputId: "accepted", runId: "old", closedAt: 5 },
    ]);
    f.inputs.reconcileRequestSuccess.mockResolvedValue({
      inputId: "accepted",
      closedAt: 5,
    });
    expect(await f.wake("s")).toBe(false);
    if (!batch) throw new Error("missing batch");
    expect(f.store.getNoticeBatch(batch)[0]).toMatchObject({
      noticeState: "accepted",
      noticeInputId: "accepted",
    });
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("keeps a claim after rendering fails, avoiding a retry loop", async () => {
    const f = fixture();
    await add(f.store);
    const original = f.store.getNoticeBatch.bind(f.store);
    vi.spyOn(f.store, "getNoticeBatch").mockImplementation((batch) =>
      original(batch).map((row) =>
        row.noticeWakeRunId ? { ...row, noticePayload: null } : row,
      ),
    );
    await expect(f.wake("s")).rejects.toThrow("not frozen");
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
    expect(await f.wake("s")).toBe(false);
    expect(f.gate.isHeld("s")).toBe(false);
  });

  it("coalesces ready results and admits the matching Goal ticket", async () => {
    const ticket = { token: Symbol(), goalId: "g", executionEpoch: 1 };
    const runGoalTurn = vi
      .fn<Options["runGoalTurn"]>()
      .mockResolvedValue({ status: "succeeded" });
    const finishGoalTurn = vi.fn().mockResolvedValue(undefined);
    const f = fixture({ runGoalTurn, finishGoalTurn });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.admitTurnInBoundary.mockResolvedValue(ticket);
    await add(f.store, { goalId: "g" });
    await add(f.store, {
      jobId: "job2",
      goalId: "g",
      outputTail: "second-result",
    });
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(finishGoalTurn).toHaveBeenCalledOnce();
    });
    const opening = runGoalTurn.mock.calls[0]?.[2].runtimeInput;
    expect(opening.body).toContain("second-result");
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
    expect(f.store.get("job2")?.noticeWakeRunId).toBe("wake");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("does not take a Goal ticket when another backend wins the batch claim", async () => {
    const f = fixture();
    await add(f.store, { goalId: "g" });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    vi.spyOn(f.store, "claimNoticeWake").mockResolvedValue(false);
    expect(await f.wake("s")).toBe(false);
    expect(f.goals.admitTurnInBoundary).not.toHaveBeenCalled();
    expect(f.gate.isHeld("s")).toBe(false);
  });
  it("releases a claim on shutdown before submit and refunds an acquired ticket", async () => {
    let closed = false;
    let resume!: () => void;
    let admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const finish = vi.fn().mockResolvedValue(undefined);
    const f = fixture({ isClosed: () => closed, finishGoalTurn: finish });
    await add(f.store, { goalId: "g" });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.admitTurnInBoundary.mockImplementation(async () => {
      admitted();
      await wait;
      return { token: Symbol(), goalId: "g", executionEpoch: 1 };
    });
    const result = f.wake("s");
    await entered;
    closed = true;
    resume();
    expect(await result).toBe(false);
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
    expect(finish.mock.calls[0]?.[2]).toMatchObject({
      status: "not_admitted",
      refundUnstartedTurn: true,
    });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.gate.isHeld("s")).toBe(false);
  });
  it("keeps a claim accepted by another run but refunds its own unstarted Goal ticket", async () => {
    const ticket = { token: Symbol(), goalId: "g", executionEpoch: 1 };
    const finish = vi.fn().mockResolvedValue(undefined);
    const f = fixture({
      runGoalTurn: vi.fn().mockRejectedValue(new SessionRunBusyError("s", [])),
      finishGoalTurn: finish,
    });
    await add(f.store, { goalId: "g" });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.admitTurnInBoundary.mockResolvedValue(ticket);
    f.inputs.listBySource.mockResolvedValue([
      { inputId: "other", runId: "other" },
    ]);
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(finish).toHaveBeenCalledOnce();
    });
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
    expect(finish.mock.calls[0]?.[2]).toMatchObject({
      refundUnstartedTurn: true,
    });
  });

  it("returns a Goal ticket as not admitted only for a proven unstarted race", async () => {
    const ticket = { token: Symbol(), goalId: "g", executionEpoch: 1 };
    const finish = vi.fn().mockResolvedValue(undefined);
    const runGoal = vi.fn().mockRejectedValue(new SessionRunBusyError("s", []));
    const f = fixture({ runGoalTurn: runGoal, finishGoalTurn: finish });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.admitTurnInBoundary.mockResolvedValue(ticket);
    await add(f.store, { goalId: "g" });
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(finish).toHaveBeenCalledOnce();
    });
    expect(finish.mock.calls[0]?.[2]).toMatchObject({ status: "not_admitted" });
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
  });

  it("keeps Goal usage unknown when wake execution fails for an unknown reason", async () => {
    const ticket = { token: Symbol(), goalId: "g", executionEpoch: 1 };
    const finish = vi.fn().mockResolvedValue(undefined);
    const f = fixture({
      runGoalTurn: vi.fn().mockRejectedValue(new Error("unknown failure")),
      finishGoalTurn: finish,
    });
    await add(f.store, { goalId: "g" });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.admitTurnInBoundary.mockResolvedValue(ticket);
    expect(await f.wake("s")).toBe(true);
    await vi.waitFor(() => {
      expect(finish).toHaveBeenCalledOnce();
    });
    expect(finish.mock.calls[0]?.[2]).toMatchObject({
      status: "failed",
      usage: { usageComplete: false },
    });
    expect(f.store.get("job")?.noticeWakeRunId).toBe("wake");
  });

  it("does not claim a Goal batch when the budget or owner blocks admission", async () => {
    const f = fixture();
    await add(f.store, { goalId: "g" });
    f.goals.peekSnapshot.mockReturnValue({ status: "active", goalId: "g" });
    f.goals.isAutomaticRunBudgetExhausted.mockReturnValue(true);
    expect(await f.wake("s")).toBe(false);
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
    f.goals.isAutomaticRunBudgetExhausted.mockReturnValue(false);
    vi.mocked(f.opts.isGoalOwnedHere).mockResolvedValue(false);
    expect(await f.wake("s")).toBe(false);
    expect(f.store.get("job")?.noticeWakeRunId).toBeNull();
  });

  it("does not wake lost, paused goal, or unknown durable goal work", async () => {
    const lost = fixture();
    await add(lost.store, { status: "lost" });
    expect(await lost.wake("s")).toBe(false);
    const paused = fixture();
    await add(paused.store);
    paused.goals.peekSnapshot.mockReturnValue({
      status: "paused",
      goalId: "g",
    });
    expect(await paused.wake("s")).toBe(false);
    const unknown = fixture({
      hasUnknownActiveGoal: vi.fn().mockResolvedValue(true),
    });
    await add(unknown.store);
    expect(await unknown.wake("s")).toBe(false);
  });
});
