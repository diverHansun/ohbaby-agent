import { describe, expect, it, vi } from "vitest";
import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";
import { createInMemoryUiStateStore } from "../ui-state/index.js";
import { startRunStreamProjection } from "./run-stream-adapter.js";

describe("startRunStreamProjection", () => {
  it("emits compact notices from context prepared events", async () => {
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

    streamBridge.publish("run/run_1", "run.context.prepared", {
      compaction: {
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
      },
      hasSummary: true,
      runId: "run_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 3,
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "context:compact:session_1",
        level: "info",
        title: "Context compacted",
      }),
    );
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
              id: "message_assistant",
              parts: [{ text: "fast answer", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
      status: { kind: "idle" },
    });
  });
});
