import { RuntimeInputSnapshotChangedError } from "../../core/lifecycle/runtime-input-error.js";
import { createBus } from "../../bus/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentContinuationCoordinator } from "./continuation-coordinator.js";
import { InMemorySubagentExecutionStore } from "./execution-store.js";
import { InMemoryCurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../../runtime/prompt-scheduler/in-memory-store.js";
import { createInMemoryRunLedger } from "../../runtime/run-ledger/in-memory.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import type { ExecutionFactView } from "./execution-facts.js";

async function setup() {
  const executions = new InMemorySubagentExecutionStore();
  const runLedger = createInMemoryRunLedger();
  await runLedger.createPending({
    runId: "root",
    sessionId: "parent",
    triggerSource: "user",
  });
  await runLedger.markRunning("root");
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const inputs = new InMemoryCurrentRunInputStore({
    runLedger,
    promptStore: new InMemoryPromptSubmissionStore(),
    messageManager: messages,
  });
  const execution = (
    await executions.accept({
      executionId: "execution",
      requestId: "call",
      parentSessionId: "parent",
      requesterScopeId: "primary",
      requesterRunId: "root",
      rootRunId: "root",
      rootSessionId: "parent",
      subagentId: "child",
      mode: "background",
      prompt: "task",
      createdAt: Date.now(),
    })
  ).record;
  let blocked = false;
  let activity = 0;
  const coordinator = createSubagentContinuationCoordinator({
    executions,
    inputs,
    prepareResult: () => Promise.resolve({ body: "complete result" }),
    collectFacts: (record) =>
      Promise.resolve({
        executionId: record.executionId,
        subagentId: record.subagentId,
        status: record.status,
        phase: blocked ? "awaiting-approval" : "running",
        collectedAt: Date.now(),
        lastActivityAt: ++activity,
        currentTools: [],
        recentTools: [],
        omittedTools: 0,
        approval: blocked
          ? { blocked: true, permissionIds: ["approval"], fingerprint: "v1" }
          : { blocked: false, permissionIds: [] },
      } satisfies ExecutionFactView),
  });
  const port = coordinator.createPort({ runId: "root", sessionId: "parent" });
  let requestNumber = 0;
  async function processPending(): Promise<void> {
    const protectedMessages = await port.beforeStep();
    const requestId = `request-${String(++requestNumber)}`;
    await messages.createMessage({
      id: requestId,
      sessionId: "parent",
      runId: "root",
      role: "assistant",
      agent: "default",
    });
    const request = {
      requestId,
      messageId: requestId,
      runId: "root",
      purpose: "agent-step",
      step: requestNumber,
      attempt: 1,
      startedAt: Date.now(),
      outcome: "running" as const,
      inputIds: protectedMessages.map(
        (message) => message.info.runtimeInput?.inputId ?? "",
      ),
    };
    await port.admitRequestAttempt(request);
    await messages.updateMessage(requestId, {
      modelRequests: [{ ...request, outcome: "success", endedAt: Date.now() }],
    });
    await port.confirmRequestSuccess(requestId);
  }
  return {
    executions,
    execution,
    inputs,
    port,
    coordinator,
    processPending,
    messages,
    setBlocked: (value: boolean) => {
      blocked = value;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("subagent continuation", () => {
  it("waits 60 then 120 seconds; lost terminal wake is recovered by independent reconcile", async () => {
    vi.useFakeTimers();
    const s = await setup();
    let finished = false;
    const first = s.port.beforeFinish().then((r) => {
      finished = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe("continue");
    const firstInputs = await s.inputs.listPending("root");
    expect(firstInputs).toHaveLength(1);
    expect(firstInputs[0].observation?.reason).toBe("deadline");
    // A real terminal takes priority over an unsent deadline and needs no host signal.
    await s.executions.finish(s.execution, {
      status: "completed",
      output: "complete result",
      completedAt: Date.now(),
    });
    const batch = await s.port.beforeStep();
    expect(batch).toHaveLength(1);
    expect(batch[0].info.runtimeInput?.kind).toBe("subagent-result");
    expect(
      (await s.inputs.getInput(firstInputs[0].inputId))?.closeReason,
    ).toBeDefined();
  });
  it("recovers a terminal without a signal, never finishes before successful result processing", async () => {
    vi.useFakeTimers();
    const s = await setup();
    let finished = false;
    const waiting = s.port.beforeFinish().then((r) => {
      finished = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1);
    await s.executions.finish(s.execution, {
      status: "failed",
      error: "broken",
      completedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await waiting).toBe("continue");
    expect(finished).toBe(true);
    expect(await s.port.beforeFinish()).toBe("continue");
    expect((await s.inputs.listPending("root"))[0].source).toBe(
      "subagent-result",
    );
  });
  it("cancels a held wait and removes its timers", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const controller = new AbortController();
    const waiting = s.port.beforeFinish(controller.signal);
    const rejected = expect(waiting).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("stopped"));
    await rejected;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await s.inputs.listPending("root")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses 120 seconds only after a successful deadline request, without progress resets", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const first = s.port.beforeFinish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toBe("continue");
    await s.processPending();
    let finished = false;
    const second = s.port.beforeFinish().then((value) => {
      finished = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe("continue");
    expect(
      (await s.inputs.listPending("root"))[0].observation?.waitGeneration,
    ).toBe(2);
  });
  it("pauses repeat model checks only after successful approval disclosure and still reconciles", async () => {
    vi.useFakeTimers();
    const s = await setup();
    s.setBlocked(true);
    expect(await s.port.beforeFinish()).toBe("continue");
    await s.processPending();
    let finished = false;
    const waiting = s.port.beforeFinish().then((value) => {
      finished = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(finished).toBe(false);
    expect(await s.inputs.listPending("root")).toHaveLength(0);
    // Lost approval signal is discovered by the independent five-second check.
    s.setBlocked(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toBe("continue");
    expect((await s.inputs.listPending("root"))[0].observation?.reason).toBe(
      "approval-change",
    );
  });
  it("invalidates an unsent approval snapshot at admission but keeps ordinary progress eligible", async () => {
    vi.useFakeTimers();
    const s = await setup();
    s.setBlocked(true);
    expect(await s.port.beforeFinish()).toBe("continue");
    const old = (await s.inputs.listPending("root"))[0];
    s.setBlocked(false);
    await expect(
      s.port.admitRequestAttempt({
        requestId: "stale",
        messageId: "stale",
        runId: "root",
        step: 1,
        attempt: 1,
        purpose: "agent-step",
        startedAt: 0,
        outcome: "running",
        inputIds: [old.inputId],
      }),
    ).rejects.toBeInstanceOf(RuntimeInputSnapshotChangedError);
    expect((await s.inputs.getInput(old.inputId))?.closedAt).toBeDefined();
    await s.processPending();
    expect(await s.inputs.listPending("root")).toHaveLength(0);
    const controller = new AbortController();
    let nextFinished = false;
    const next = s.port.beforeFinish(controller.signal).then(() => {
      nextFinished = true;
    });
    const cancelled = expect(next).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(5000);
    expect(nextFinished).toBe(false);
    expect(await s.inputs.listPending("root")).toHaveLength(0);
    controller.abort(new Error("stop"));
    await cancelled;
  });
  it("finishes only after the exact result request succeeded and marks delivery processed", async () => {
    const s = await setup();
    await s.executions.finish(s.execution, {
      status: "completed",
      output: "result",
      completedAt: Date.now(),
    });
    expect(await s.port.beforeFinish()).toBe("continue");
    await s.processPending();
    expect(await s.port.beforeFinish()).toBe("finish");
    expect((await s.executions.get(s.execution))?.delivery.state).toBe(
      "processed",
    );
  });

  it("resets the next wait to 60 seconds only after processing a real terminal result", async () => {
    vi.useFakeTimers();
    const s = await setup();
    await s.executions.accept({
      ...s.execution,
      executionId: "second",
      requestId: "second",
    });
    const first = s.port.beforeFinish();
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    await s.processPending();
    await s.executions.finish(s.execution, {
      status: "completed",
      output: "done",
      completedAt: Date.now(),
    });
    await s.processPending();
    let done = false;
    const next = s.port.beforeFinish().then((value) => {
      done = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(done).toBe(false);
    expect(s.coordinator.getWaitState("root")).toEqual({
      waiting: true,
      approvalBlocked: false,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBe("continue");
    expect(s.coordinator.getWaitState("root").waiting).toBe(false);
  });
});
