import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { createSessionSubagentSupervisor } from "./session-supervisor.js";
import { createSubagentDelivery } from "./delivery.js";
import { InMemorySubagentExecutionStore } from "./execution-store.js";
import { createInMemoryRunLedger } from "../../runtime/run-ledger/index.js";
import { InMemoryCurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../../runtime/prompt-scheduler/in-memory-store.js";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { InMemoryGoalPersistence } from "../../goals/index.js";

async function fixture() {
  const executions = new InMemorySubagentExecutionStore();
  const runs = createInMemoryRunLedger();
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const inputs = new InMemoryCurrentRunInputStore({
    runLedger: runs,
    promptStore: new InMemoryPromptSubmissionStore(),
    messageManager: messages,
  });
  const goals = new InMemoryGoalPersistence();
  const delivery = createSubagentDelivery({
    executions,
    inputs,
    runs,
    goalHistory: goals,
    receivingGoal: () => undefined,
    now: () => 10,
  });
  const { record } = await executions.accept({
    executionId: "child",
    requestId: "dispatch",
    parentSessionId: "parent",
    requesterScopeId: "primary",
    requesterRunId: "root",
    rootSessionId: "parent",
    rootRunId: "root",
    goalId: null,
    subagentId: "child",
    mode: "background",
    prompt: "task",
    createdAt: 1,
  });
  await executions.finish(record, {
    status: "completed",
    output: "done",
    completedAt: 2,
  });
  const current = async () => {
    const value = await executions.get(record);
    assert(value);
    return value;
  };
  return {
    executions,
    runs,
    inputs,
    messages,
    goals,
    delivery,
    record,
    current,
  };
}

describe("subagent delivery decisions", () => {
  it("retries only a request-free entrance after its run has ended, with durable backoff", async () => {
    const f = await fixture();
    expect(await f.delivery.checkWakeup(await f.current())).toEqual({
      ready: true,
    });
    await f.executions.claimWakeup(f.record, 3, { runId: "wake" });
    expect(await f.delivery.checkWakeup(await f.current())).toEqual({
      ready: false,
      retryAt: 5003,
    });
    await f.runs.createPending({
      runId: "wake",
      sessionId: "parent",
      triggerSource: "subagent",
    });
    expect(await f.delivery.checkWakeup(await f.current())).toEqual({
      ready: false,
    });
    await f.runs.markFailed("wake", new Error("entrance failure"));
    expect(await f.delivery.checkWakeup(await f.current())).toEqual({
      ready: false,
      retryAt: 5003,
    });
    await f.executions.stopWakeups("parent", "wake", 4);
    expect(await f.delivery.checkWakeup(await f.current())).toEqual({
      ready: false,
    });
  });
  it.each([true, false])(
    "uses the input attempt as authority even if delivery linking persisted=%s",
    async (linked) => {
      const f = await fixture();
      await f.runs.createPending({
        runId: "busy",
        sessionId: "parent",
        triggerSource: "user",
      });
      await f.runs.markRunning("busy");
      const inputId = "subagent-result:child:busy";
      await f.inputs.acceptRuntimeInput({
        inputId,
        runId: "busy",
        sessionId: "parent",
        source: "subagent-result",
        sourceId: "subagent-result:child",
        message: {
          info: {
            id: "result",
            sessionId: "parent",
            runId: "busy",
            role: "user",
            agent: "default",
            time: { created: 4 },
            runtimeInput: {
              kind: "subagent-result",
              inputId,
              sourceId: "subagent-result:child",
              targetRunId: "busy",
            },
          },
          parts: [
            {
              id: "result-part",
              messageId: "result",
              sessionId: "parent",
              type: "text",
              orderIndex: 0,
              text: "done",
            },
          ],
        },
      });
      if (linked) await f.executions.markDelivered(f.record, inputId, 4);
      await f.messages.createMessage({
        id: "request",
        sessionId: "parent",
        runId: "busy",
        role: "assistant",
        agent: "default",
      });
      await f.inputs.admitRequestAttempt({
        requestId: "request",
        messageId: "request",
        runId: "busy",
        purpose: "agent-step",
        step: 1,
        attempt: 1,
        startedAt: 5,
        outcome: "running",
        inputIds: [inputId],
      });
      await f.inputs.close("busy", "cancelled");
      await f.runs.markCancelled("busy");
      expect(await f.delivery.checkWakeup(await f.current())).toEqual({
        ready: false,
      });
      expect((await f.current()).delivery.wakeupAttemptedAt).toBeDefined();
      // An idle observer must settle instead of publishing no-op claims forever.
      vi.useFakeTimers();
      let changes = 0;
      const supervisor = createSessionSubagentSupervisor({
        executions: f.executions,
        checkWakeup: (record) => f.delivery.checkWakeup(record),
        isIdle: () => true,
        wake: () => {
          throw new Error("An attempted input must not wake again");
        },
      });
      const unsubscribe = f.executions.subscribe(() => {
        changes++;
        if (changes > 5) supervisor.dispose();
      });
      try {
        supervisor.observe("parent");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(changes).toBe(0);
      } finally {
        unsubscribe();
        supervisor.dispose();
        vi.useRealTimers();
      }
    },
  );
  it("never infers ordinary ownership from a cleared or paused Goal", async () => {
    const f = await fixture();
    const legacy = { ...(await f.current()), goalId: undefined };
    expect(await f.delivery.resolveGoal(legacy)).toBeNull();
    await f.goals.append("parent", {
      type: "create",
      goalId: "g",
      objective: "task",
    });
    await f.goals.append("parent", { type: "clear", goalId: "g" });
    expect(await f.delivery.resolveGoal(legacy)).toBeUndefined();
    expect(
      await f.delivery.canDeliver({ ...legacy, goalId: "g" }, "ordinary-run"),
    ).toBe(false);
    expect(await f.delivery.canDeliver(await f.current(), "ordinary-run")).toBe(
      true,
    );
  });
});
