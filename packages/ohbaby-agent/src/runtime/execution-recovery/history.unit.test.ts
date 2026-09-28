import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import { repairInterruptedRunHistory } from "./history.js";

describe("interrupted run history", () => {
  it("atomically preserves an in-memory terminal result committed after the recovery read", async () => {
    const store = createInMemoryMessageStore();
    const manager = createMessageManager({ bus: createBus(), store });
    const message = await manager.createMessage({
      sessionId: "s",
      runId: "A",
      role: "assistant",
      agent: "primary",
    });
    const tool = await manager.appendPart(message.id, {
      type: "tool",
      callId: "call",
      tool: "write",
      state: { status: "running", input: {} },
    });
    const get = manager.getPart.bind(manager);
    vi.spyOn(manager, "getPart").mockImplementationOnce(async (id) => {
      const stale = await get(id);
      await store.updatePart(
        id,
        {
          state: { status: "completed", input: {}, output: "real result" },
          metadata: {
            execution: {
              phase: "ended",
              phaseStartedAt: 123,
              endedAt: 123,
              createdAt: 1,
            },
          },
        },
        123,
      );
      return stale;
    });
    await repairInterruptedRunHistory(manager, {
      sessionId: "s",
      runId: "A",
      reason: "user-stop",
      now: () => 456,
    });
    expect(await manager.getPart(tool.id)).toMatchObject({
      state: { status: "completed", output: "real result" },
      metadata: { execution: { endedAt: 123 } },
    });
    expect(
      (await manager.getPart(tool.id))?.metadata?.recovery,
    ).toBeUndefined();
  });
  it("repairs only unresolved calls of the exact run, preserving committed results", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
    });
    const a = await manager.createMessage({
      sessionId: "s",
      runId: "A",
      role: "assistant",
      agent: "primary",
    });
    const b = await manager.createMessage({
      sessionId: "s",
      runId: "B",
      role: "assistant",
      agent: "primary",
    });
    const pending = await manager.appendPart(a.id, {
      type: "tool",
      callId: "call-a",
      tool: "write",
      state: { status: "pending", input: { path: "a" }, raw: "{}" },
    });
    const complete = await manager.appendPart(a.id, {
      type: "tool",
      callId: "complete-a",
      tool: "write",
      state: { status: "completed", input: {}, output: "saved" },
    });
    const other = await manager.appendPart(b.id, {
      type: "tool",
      callId: "call-b",
      tool: "write",
      state: { status: "running", input: {} },
    });
    await repairInterruptedRunHistory(manager, {
      sessionId: "s",
      runId: "A",
      reason: "process-interrupted",
      now: () => 1234,
    });
    const repaired = await manager.getPart(pending.id);
    expect(repaired).toMatchObject({
      id: pending.id,
      callId: "call-a",
      state: { status: "error" },
      metadata: {
        recovery: {
          reason: "process-interrupted",
          outcome: "unknown",
          recordedAt: 1234,
        },
      },
    });
    expect(
      repaired?.type === "tool" && repaired.state.status === "error"
        ? repaired.state.error
        : undefined,
    ).toContain("outcome unknown");
    expect(await manager.getPart(complete.id)).toEqual(complete);
    expect(await manager.getPart(other.id)).toEqual(other);
    await repairInterruptedRunHistory(manager, {
      sessionId: "s",
      runId: "A",
      reason: "process-interrupted",
      now: () => 5678,
    });
    expect(await manager.getPart(pending.id)).toEqual(repaired);
    const model = await manager.toModelMessages("s");
    expect(JSON.stringify(model)).toContain("outcome unknown");
  });

  it("never infers not-started from a persisted preparing phase or absent start time", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
    });
    const a = await manager.createMessage({
      sessionId: "s",
      runId: "A",
      role: "assistant",
      agent: "primary",
    });
    const call = await manager.appendPart(a.id, {
      type: "tool",
      callId: "call",
      tool: "bash",
      state: { status: "pending", input: {}, raw: "{}" },
      metadata: {
        execution: { phase: "preparing", phaseStartedAt: 10, createdAt: 10 },
      },
    });
    await repairInterruptedRunHistory(manager, {
      sessionId: "s",
      runId: "A",
      reason: "user-stop",
      now: () => 2000,
    });
    const repaired = await manager.getPart(call.id);
    expect(repaired).toMatchObject({
      metadata: {
        execution: { phase: "ended", endTimeSource: "recovery" },
        recovery: { outcome: "unknown" },
      },
    });
    expect(repaired?.metadata?.execution?.executionStartedAt).toBeUndefined();
  });
});

it("closes unfinished request attempts without replacing completed requests or native model parts", async () => {
  const manager = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const message = await manager.createMessage({
    sessionId: "s",
    runId: "A",
    role: "assistant",
    agent: "primary",
  });
  const request = {
    requestId: "req",
    runId: "A",
    messageId: message.id,
    step: 1,
    attempt: 1,
    purpose: "main",
    startedAt: 1,
    outcome: "running" as const,
  };
  const complete = {
    ...request,
    requestId: "complete",
    outcome: "success" as const,
    endedAt: 3,
  };
  await manager.updateMessage(message.id, {
    modelRequests: [request, complete],
  });
  const native = await manager.appendPart(message.id, {
    type: "model-state",
    modelState: {
      version: 1,
      origin: {
        provider: "test",
        model: "m",
        protocol: "anthropic",
        endpoint: "https://example.invalid",
      },
      output: {
        protocol: "anthropic",
        items: [
          {
            type: "thinking",
            thinking: "native reasoning",
            signature: "preserve",
          },
        ],
      },
      estimate: { tokens: 3, source: "reasoning" },
    },
  });
  await repairInterruptedRunHistory(manager, {
    sessionId: "s",
    runId: "A",
    reason: "process-interrupted",
    now: () => 123,
  });
  expect((await manager.listByIds("s", [message.id]))[0]?.info).toMatchObject({
    modelRequests: [
      {
        ...request,
        outcome: "aborted",
        endedAt: 123,
        endTimeSource: "recovery",
      },
      complete,
    ],
  });
  await repairInterruptedRunHistory(manager, {
    sessionId: "s",
    runId: "A",
    reason: "process-interrupted",
    now: () => 999,
  });
  expect((await manager.listByIds("s", [message.id]))[0]?.info).toMatchObject({
    modelRequests: [{ endedAt: 123 }, complete],
  });
  expect(await manager.getPart(native.id)).toEqual(native);
});
