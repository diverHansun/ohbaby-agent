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
  const coordinator = createSubagentContinuationCoordinator({
    executions,
    inputs,
    prepareResult: () => Promise.resolve({ body: "complete result" }),
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
      purpose: "agent-step" as const,
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
    runLedger,
    executions,
    execution,
    inputs,
    port,
    coordinator,
    processPending,
    messages,
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("subagent continuation", () => {
  it("withdraws an unsent supervision snapshot when a real result arrives", async () => {
    const s = await setup();
    await s.inputs.acceptRuntimeInput({
      inputId: "observation",
      runId: "root",
      sessionId: "parent",
      source: "subagent-status",
      sourceId: "review",
      message: {
        info: {
          id: "review",
          sessionId: "parent",
          runId: "root",
          role: "user",
          agent: "default",
          time: { created: 1 },
        },
        parts: [
          {
            id: "review:text",
            messageId: "review",
            sessionId: "parent",
            orderIndex: 0,
            type: "text",
            text: "child is still running",
          },
        ],
      },
    });
    await s.executions.finish(s.execution, {
      status: "completed",
      output: "done",
      completedAt: 10,
    });
    const batch = await s.port.beforeStep();
    expect(batch.map((message) => message.info.runtimeInput?.kind)).toEqual([
      "subagent-result",
    ]);
    expect((await s.inputs.getInput("observation"))?.closedAt).toBeDefined();
  });
  it("finishes the primary turn while its background execution continues", async () => {
    const s = await setup();
    expect(await s.port.beforeFinish()).toBe("finish");
    expect((await s.executions.get(s.execution))?.status).toBe("queued");
    expect(await s.inputs.listPending("root")).toEqual([]);
  });
  it("delivers an earlier turn's result and confirms only a successful request", async () => {
    const s = await setup();
    await s.executions.finish(s.execution, {
      status: "completed",
      output: "report",
      completedAt: 10,
    });
    await s.inputs.close("root", "user-stop");
    await s.runLedger.createPending({
      runId: "next",
      sessionId: "parent",
      triggerSource: "user",
    });
    await s.runLedger.markRunning("next");
    const port = s.coordinator.createPort({
      runId: "next",
      sessionId: "parent",
    });
    const batch = await port.beforeStep();
    expect(batch).toHaveLength(1);
    expect(batch[0].info.runtimeInput).toMatchObject({
      sourceId: "subagent-result:execution",
      targetRunId: "next",
    });
    expect((await s.executions.get(s.execution))?.delivery.state).toBe(
      "delivered",
    );
    expect(await port.beforeFinish()).toBe("continue");
  });
  it("reoffers a failed request in another turn without rewriting old request membership", async () => {
    const s = await setup();
    await s.executions.finish(s.execution, {
      status: "failed",
      error: "broken",
      completedAt: 10,
    });
    const first = await s.port.beforeStep();
    const firstId = first[0].info.runtimeInput?.inputId;
    if (!firstId) throw new Error("Missing original delivery input");
    await s.inputs.close("root", "user-stop");
    await s.runLedger.createPending({
      runId: "next",
      sessionId: "parent",
      triggerSource: "user",
    });
    await s.runLedger.markRunning("next");
    const port = s.coordinator.createPort({
      runId: "next",
      sessionId: "parent",
    });
    const second = await port.beforeStep();
    expect(second).toHaveLength(1);
    expect(second[0].info.runtimeInput?.inputId).not.toBe(firstId);
    expect((await s.inputs.getInput(firstId))?.runId).toBe("root");
    expect((await s.inputs.getInput(firstId))?.closedAt).toBeDefined();
    expect(second[0].info.runtimeInput?.sourceId).toBe(
      first[0].info.runtimeInput?.sourceId,
    );
    expect((await port.beforeStep()).map((m) => m.info.id)).toEqual(
      second.map((m) => m.info.id),
    );
  });
  it("finishes only after the exact result request succeeded and marks delivery processed", async () => {
    const s = await setup();
    await s.executions.finish(s.execution, {
      status: "completed",
      output: "report",
      completedAt: 10,
    });
    expect(await s.port.beforeFinish()).toBe("continue");
    await s.processPending();
    expect(await s.port.beforeFinish()).toBe("finish");
    expect((await s.executions.get(s.execution))?.delivery.state).toBe(
      "processed",
    );
  });
  it("ignores foreground and explicitly stopped work when reconciling results", async () => {
    const s = await setup();
    await s.executions.finish(s.execution, {
      status: "interrupted",
      completedAt: 10,
    });
    expect(await s.port.beforeStep()).toEqual([]);
    expect(await s.port.beforeFinish()).toBe("finish");
  });
});
