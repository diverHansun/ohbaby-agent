import { describe, expect, it, vi } from "vitest";
import { createContextWindowUsageTracker } from "../../core/context/index.js";
import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";
import { createInMemoryUiStateStore } from "../ui-state/index.js";
import { startRunStreamProjection } from "./run-stream-adapter.js";

describe("startRunStreamProjection", () => {
  it("publishes context window usage from context prepared events", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const publish = vi.fn();
    const contextWindowUsage = createContextWindowUsageTracker({
      now: () => "2026-06-06T00:00:00.000Z",
    });
    const projection = startRunStreamProjection({
      assistantMessageId: "message_assistant",
      autoStart: false,
      contextWindowUsage,
      nextMessageId: () => "message_next",
      publish,
      runId: "run_1",
      sessionId: "session_1",
      stateStore,
      streamBridge,
      timestamp: () => "2026-05-26T00:00:01.000Z",
    });

    streamBridge.publish("run/run_1", "run.context.prepared", {
      hasSummary: false,
      runId: "run_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 3,
      usage: {
        contextLimit: 1_000_000,
        currentTokens: 38_400,
        inputBudgetTokens: 950_000,
        modelId: "deepseek-v4-pro",
        remainingTokens: 911_600,
        shouldCompress: false,
        usageRatio: 38_400 / 950_000,
      },
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    expect(contextWindowUsage.get("session_1")).toEqual({
      contextWindowRatio: 0.0384,
      contextWindowTokens: 1_000_000,
      currentTokens: 38_400,
      estimatedAt: "2026-06-06T00:00:00.000Z",
      modelId: "deepseek-v4-pro",
      sessionId: "session_1",
    });
    expect(publish).toHaveBeenCalledWith({
      type: "context.window.updated",
      usage: contextWindowUsage.get("session_1"),
    });
  });

  it("does not emit persistent notices for successful context compaction", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const onNotice = vi.fn();
    const projection = startRunStreamProjection({
      assistantMessageId: "message_assistant",
      autoStart: false,
      nextMessageId: () => "message_next",
      onNotice,
      publish: vi.fn(),
      runId: "run_1",
      sessionId: "session_1",
      stateStore,
      streamBridge,
      timestamp: () => "2026-05-26T00:00:01.000Z",
    });

    const compaction = {
      status: "compacted",
      usageAfter: {
        contextLimit: 100_000,
        currentTokens: 10_000,
        modelId: "fake-model",
        remainingTokens: 90_000,
        shouldCompress: false,
        usageRatio: 0.1,
      },
      usageBefore: {
        contextLimit: 100_000,
        currentTokens: 92_000,
        modelId: "fake-model",
        remainingTokens: 8_000,
        shouldCompress: true,
        usageRatio: 0.92,
      },
    };
    streamBridge.publish("run/run_1", "run.turn.start", {
      compaction,
      hasSummary: true,
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 2,
    });
    streamBridge.publish("run/run_1", "run.context.prepared", {
      compaction,
      hasSummary: true,
      runId: "run_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 3,
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    expect(onNotice).not.toHaveBeenCalled();
  });

  it("can subscribe before a fast run ends and pump the buffered events later", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const publish = vi.fn();
    const projection = startRunStreamProjection({
      assistantMessageId: "message_assistant",
      autoStart: false,
      nextMessageId: () => "message_next",
      publish,
      runId: "run_1",
      sessionId: "session_1",
      stateStore,
      streamBridge,
      timestamp: () => "2026-05-26T00:00:01.000Z",
    });

    streamBridge.publish("run/run_1", "run.updated", {
      run: {
        createdAt: 1,
        runId: "run_1",
        sessionId: "session_1",
        startedAt: 2,
        status: "running",
      },
    });
    streamBridge.publish("run/run_1", "message.part.delta", {
      content: "fast answer",
      delta: "fast answer",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 3,
    });
    streamBridge.publish("run/run_1", "run.updated", {
      run: {
        createdAt: 1,
        endedAt: 4,
        runId: "run_1",
        sessionId: "session_1",
        startedAt: 2,
        status: "succeeded",
      },
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    await expect(stateStore.readSnapshot()).resolves.toMatchObject({
      runs: [
        {
          id: "run_1",
          status: { kind: "idle" },
        },
      ],
      sessions: [
        {
          messages: [
            {
              completedAt: "2026-05-26T00:00:01.000Z",
              id: "message_assistant",
              parts: [{ text: "fast answer", type: "text" }],
              role: "assistant",
              status: "completed",
            },
          ],
        },
      ],
      status: { kind: "idle" },
    });
    const publishedEvents = publish.mock.calls.map((call): unknown => call[0]);
    expect(
      publishedEvents.some((event) =>
        hasMessageStatus(event, "message.appended", "streaming"),
      ),
    ).toBe(true);
    expect(
      publishedEvents.some((event) =>
        hasMessageStatus(event, "message.updated", "completed"),
      ),
    ).toBe(true);
    expect(
      publishedEvents.some(
        (event) =>
          hasMessageStatus(event, "message.updated", "completed") &&
          getMessageField(event, "completedAt") === "2026-05-26T00:00:01.000Z",
      ),
    ).toBe(true);
  });

  it("publishes lightweight deltas while keeping the draft in state", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const publish = vi.fn();
    const projection = startRunStreamProjection({
      assistantMessageId: "message_assistant",
      autoStart: false,
      nextMessageId: () => "message_next",
      publish,
      runId: "run_1",
      sessionId: "session_1",
      stateStore,
      streamBridge,
      timestamp: () => "2026-05-26T00:00:01.000Z",
    });

    streamBridge.publish("run/run_1", "message.part.delta", {
      content: "Hello",
      delta: "Hello",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 1,
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    const publishedEvents = publish.mock.calls.map((call): unknown => call[0]);
    expect(
      publishedEvents.filter(
        (event) => isRecord(event) && event.type === "message.updated",
      ),
    ).toEqual([]);
    expect(
      publishedEvents.filter(
        (event) => isRecord(event) && event.type === "message.part.delta",
      ),
    ).toEqual([
      expect.objectContaining({
        content: "Hello",
        delta: "Hello",
        messageId: "message_assistant",
      }),
    ]);
    await expect(stateStore.readSnapshot()).resolves.toMatchObject({
      sessions: [
        {
          messages: [
            {
              id: "message_assistant",
              parts: [{ text: "Hello", type: "text" }],
              status: "streaming",
            },
          ],
        },
      ],
    });
  });

  it("appends text that arrives after a tool result in chronological part order", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const projection = startRunStreamProjection({
      assistantMessageId: "message_assistant",
      autoStart: false,
      nextMessageId: () => "message_next",
      publish: vi.fn(),
      runId: "run_1",
      sessionId: "session_1",
      stateStore,
      streamBridge,
      timestamp: () => "2026-05-26T00:00:01.000Z",
    });

    streamBridge.publish("run/run_1", "message.part.delta", {
      content: "I will inspect it.",
      delta: "I will inspect it.",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 1,
    });
    streamBridge.publish("run/run_1", "run.tool.start", {
      callId: "call_read",
      params: { file_path: "README.md" },
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 2,
      toolName: "read",
    });
    streamBridge.publish("run/run_1", "run.tool.result", {
      callId: "call_read",
      result: {
        output: "README content",
        status: "success",
      },
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 3,
    });
    streamBridge.publish("run/run_1", "message.part.delta", {
      content: "Done.",
      delta: "Done.",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 4,
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    const snapshot = await stateStore.readSnapshot();
    expect(snapshot.sessions[0]?.messages[0]?.parts).toEqual([
      { text: "I will inspect it.", type: "text" },
      {
        call: {
          id: "call_read",
          input: { file_path: "README.md" },
          name: "read",
          status: "completed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_read",
          error: undefined,
          output: "README content",
        },
        type: "tool-result",
      },
      { text: "Done.", type: "text" },
    ]);
  });
});

function hasMessageStatus(
  event: unknown,
  type: string,
  status: string,
): boolean {
  return (
    isRecord(event) &&
    event.type === type &&
    isRecord(event.message) &&
    event.message.id === "message_assistant" &&
    event.message.status === status
  );
}

function getMessageField(event: unknown, field: string): unknown {
  return isRecord(event) && isRecord(event.message)
    ? event.message[field]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
