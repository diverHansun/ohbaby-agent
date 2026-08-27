import { describe, expect, it, vi } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import { createContextWindowUsageTracker } from "../../core/context/index.js";
import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";
import { createInMemoryUiStateStore } from "../ui-state/index.js";
import { startRunStreamProjection } from "./run-stream-adapter.js";

describe("startRunStreamProjection", () => {
  it("shows automatic compaction progress until context preparation completes", async () => {
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
      status: { kind: "running", runId: "run_1" },
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

    streamBridge.publish("run/run_1", "run.context.compacting", {
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 2,
    });
    streamBridge.publish("run/run_1", "run.context.prepared", {
      hasSummary: false,
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 3,
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    expect(publish).toHaveBeenNthCalledWith(1, {
      status: {
        kind: "running",
        runId: "run_1",
        title: "Compacting...",
      },
      timestamp: expect.any(Number) as number,
      type: "runtime.updated",
    });
    expect(publish).toHaveBeenNthCalledWith(2, {
      status: { kind: "running", runId: "run_1" },
      timestamp: expect.any(Number) as number,
      type: "runtime.updated",
    });
    await expect(stateStore.readSnapshot()).resolves.toMatchObject({
      status: { kind: "running", runId: "run_1" },
    });
  });

  it("lets terminal run state clear compaction progress after an early exit", async () => {
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
      status: { kind: "running", runId: "run_1" },
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

    streamBridge.publish("run/run_1", "run.context.compacting", {
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 2,
    });
    streamBridge.publish("run/run_1", "run.updated", {
      run: {
        createdAt: 1,
        endedAt: 3,
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
      status: { kind: "idle" },
    });
  });

  it("does not project run status from a background session", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_active",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_active",
          messages: [],
          title: "Active session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_background",
          messages: [],
          title: "Background session",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "running", runId: "run_active" },
    });
    const publish = vi.fn();
    const projection = startRunStreamProjection({
      assistantMessageId: "message_assistant",
      autoStart: false,
      nextMessageId: () => "message_next",
      publish,
      runId: "run_background",
      sessionId: "session_background",
      stateStore,
      streamBridge,
      timestamp: () => "2026-05-26T00:00:01.000Z",
    });

    streamBridge.publish("run/run_background", "run.context.compacting", {
      runId: "run_background",
      sessionId: "session_background",
      step: 1,
      timestamp: 2,
    });
    streamBridge.publish("run/run_background", "run.context.prepared", {
      hasSummary: false,
      runId: "run_background",
      sessionId: "session_background",
      step: 1,
      timestamp: 3,
    });
    streamBridge.publish("run/run_background", "run.updated", {
      run: {
        createdAt: 1,
        endedAt: 4,
        runId: "run_background",
        sessionId: "session_background",
        startedAt: 2,
        status: "succeeded",
      },
    });
    streamBridge.end("run/run_background");

    projection.start();
    await projection.done;

    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime.updated" }),
    );
    await expect(stateStore.readSnapshot()).resolves.toMatchObject({
      status: { kind: "running", runId: "run_active" },
    });
  });

  it("checks active-session ownership at the conditional status write", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const baseStateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "First",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_2",
          messages: [],
          title: "Second",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "running", runId: "run_1" },
    });
    const stateStore = {
      ...baseStateStore,
      updateStatusForActiveSession(
        ...args: Parameters<typeof baseStateStore.updateStatusForActiveSession>
      ): ReturnType<typeof baseStateStore.updateStatusForActiveSession> {
        void baseStateStore.setActiveSessionId("session_2");
        void baseStateStore.setStatus({ kind: "running", runId: "run_2" });
        return baseStateStore.updateStatusForActiveSession(...args);
      },
    };
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

    streamBridge.publish("run/run_1", "run.context.compacting", {
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 2,
    });
    projection.start();
    streamBridge.publish("run/run_1", "run.context.prepared", {
      hasSummary: false,
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 3,
    });
    streamBridge.end("run/run_1");

    await projection.done;

    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime.updated" }),
    );
    await expect(baseStateStore.readSnapshot()).resolves.toMatchObject({
      activeSessionId: "session_2",
      status: { kind: "running", runId: "run_2" },
    });
  });

  it("does not clear a newer status title when compaction completes", async () => {
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
      status: { kind: "running", runId: "run_1" },
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

    streamBridge.publish("run/run_1", "run.context.compacting", {
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 2,
    });
    projection.start();
    await vi.waitFor(async () => {
      await expect(stateStore.readSnapshot()).resolves.toMatchObject({
        status: { title: "Compacting..." },
      });
    });
    await stateStore.setStatus({
      kind: "running",
      runId: "run_1",
      title: "Waiting for another phase",
    });
    streamBridge.publish("run/run_1", "run.context.prepared", {
      hasSummary: false,
      runId: "run_1",
      sessionId: "session_1",
      step: 1,
      timestamp: 3,
    });
    streamBridge.end("run/run_1");

    await projection.done;

    await expect(stateStore.readSnapshot()).resolves.toMatchObject({
      status: {
        kind: "running",
        runId: "run_1",
        title: "Waiting for another phase",
      },
    });
  });

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

    projection.start();

    streamBridge.publish("run/run_1", "run.context.prepared", {
      composition: {
        "system-prompt": 10_000,
        "builtin-tools": 5_000,
        mcp: 2_000,
        skills: 1_000,
        conversation: 15_000,
        "summarized-conversation": 4_000,
        "subagent-exchanges": 1_400,
      },
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
        usageRatio: 38_400 / 950_000,
      },
    });
    await vi.waitFor(() => {
      expect(contextWindowUsage.get("session_1")).toEqual({
        composition: {
          "system-prompt": 10_000,
          "builtin-tools": 5_000,
          mcp: 2_000,
          skills: 1_000,
          conversation: 15_000,
          "summarized-conversation": 4_000,
          "subagent-exchanges": 1_400,
        },
        contextWindowRatio: 0.0384,
        contextWindowTokens: 1_000_000,
        currentTokens: 38_400,
        estimatedAt: "2026-06-06T00:00:00.000Z",
        modelId: "deepseek-v4-pro",
        sessionId: "session_1",
      });
    });

    streamBridge.publish("run/run_1", "run.context.prepared", {
      composition: {
        "system-prompt": 10_000,
        "builtin-tools": 5_000,
        mcp: 2_000,
        skills: 1_000,
        conversation: 15_000.5,
        "summarized-conversation": 4_000,
        "subagent-exchanges": 1_400,
      },
      hasSummary: false,
      runId: "run_1",
      sessionId: "session_1",
      step: 3,
      timestamp: 4,
      usage: {
        contextLimit: 1_000_000,
        currentTokens: 40_000,
        inputBudgetTokens: 950_000,
        modelId: "deepseek-v4-pro",
        remainingTokens: 910_000,
        usageRatio: 40_000 / 950_000,
      },
    });
    streamBridge.end("run/run_1");
    await projection.done;

    expect(contextWindowUsage.get("session_1")).toEqual({
      contextWindowRatio: 0.04,
      contextWindowTokens: 1_000_000,
      currentTokens: 40_000,
      estimatedAt: "2026-06-06T00:00:00.000Z",
      modelId: "deepseek-v4-pro",
      sessionId: "session_1",
    });
    expect(publish).toHaveBeenLastCalledWith({
      type: "context.window.updated",
      usage: contextWindowUsage.get("session_1"),
    });
  });

  it("keeps child context usage from replacing parent occupancy in a shared tracker", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_parent",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_parent",
          messages: [],
          title: "Parent",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
        {
          createdAt: "2026-05-26T00:00:00.000Z",
          id: "session_child",
          messages: [],
          title: "Child",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const published: UiEvent[] = [];
    const contextWindowUsage = createContextWindowUsageTracker({
      now: () => "2026-06-06T00:00:00.000Z",
    });
    const createProjection = (
      runId: string,
      sessionId: string,
    ): ReturnType<typeof startRunStreamProjection> =>
      startRunStreamProjection({
        assistantMessageId: `assistant_${runId}`,
        autoStart: false,
        contextWindowUsage,
        nextMessageId: () => `message_${runId}`,
        publish: (event): void => {
          published.push(event);
        },
        runId,
        sessionId,
        stateStore,
        streamBridge,
        timestamp: () => "2026-05-26T00:00:01.000Z",
      });
    const parent = createProjection("run_parent", "session_parent");
    const child = createProjection("run_child", "session_child");
    parent.start();
    child.start();

    streamBridge.publish("run/run_parent", "run.context.prepared", {
      hasSummary: false,
      runId: "run_parent",
      sessionId: "session_parent",
      step: 1,
      timestamp: 1,
      usage: {
        contextLimit: 1_000,
        currentTokens: 100,
        modelId: "parent-model",
        remainingTokens: 900,
        usageRatio: 0.1,
      },
    });
    streamBridge.publish("run/run_child", "run.context.prepared", {
      contextScopeId: "subagent_1",
      hasSummary: false,
      runId: "run_child",
      sessionId: "session_child",
      step: 1,
      timestamp: 2,
      usage: {
        contextLimit: 1_000,
        currentTokens: 900,
        modelId: "child-model",
        remainingTokens: 100,
        usageRatio: 0.9,
      },
    });
    streamBridge.end("run/run_parent");
    streamBridge.end("run/run_child");
    await Promise.all([parent.done, child.done]);

    expect(contextWindowUsage.get("session_parent")).toMatchObject({
      currentTokens: 100,
      modelId: "parent-model",
      sessionId: "session_parent",
    });
    expect(contextWindowUsage.get("session_child")).toMatchObject({
      currentTokens: 900,
      modelId: "child-model",
      sessionId: "session_child",
    });
    expect(
      published
        .filter((event) => event.type === "context.window.updated")
        .map((event) => event.usage.sessionId),
    ).toEqual(["session_parent", "session_child"]);
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
        usageRatio: 0.1,
      },
      usageBefore: {
        contextLimit: 100_000,
        currentTokens: 92_000,
        modelId: "fake-model",
        remainingTokens: 8_000,
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

  it("publishes reasoning events without mutating message parts", async () => {
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

    streamBridge.publish("run/run_1", "run.llm.reasoning.delta", {
      content: "thinking",
      delta: "thinking",
      messageId: "message_assistant",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 1,
    });
    streamBridge.publish("run/run_1", "run.llm.reasoning.end", {
      content: "thinking",
      messageId: "message_assistant",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 2,
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    const publishedEvents = publish.mock.calls.map((call): unknown => call[0]);
    expect(publishedEvents).toEqual([
      {
        content: "thinking",
        delta: "thinking",
        messageId: "message_assistant",
        sessionId: "session_1",
        timestamp: 1,
        type: "message.reasoning.delta",
      },
      {
        content: "thinking",
        messageId: "message_assistant",
        sessionId: "session_1",
        timestamp: 2,
        type: "message.reasoning.end",
      },
    ]);
    await expect(stateStore.readSnapshot()).resolves.toMatchObject({
      sessions: [
        {
          messages: [],
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

  it("projects successful scheduler results with failed terminal metadata as failed", async () => {
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

    for (const [index, metadata] of [
      { exitCode: null, status: "failed" },
      { exitCode: null, status: "timed_out" },
      { exitCode: null, status: "cancelled" },
      { exitCode: 1 },
    ].entries()) {
      const callId = `call_bash_${String(index)}`;
      streamBridge.publish("run/run_1", "run.tool.start", {
        callId,
        params: { command: "sleep 10" },
        toolName: "bash",
      });
      streamBridge.publish("run/run_1", "run.tool.result", {
        callId,
        result: {
          metadata,
          output: index === 0 ? "stderr text" : "partial output",
          status: "success",
        },
        toolName: "bash",
      });
    }
    streamBridge.publish("run/run_1", "run.tool.start", {
      callId: "call_list_error",
      params: { path: "/private" },
      toolName: "list",
    });
    streamBridge.publish("run/run_1", "run.tool.result", {
      callId: "call_list_error",
      result: {
        error: { message: "permission denied" },
        status: "error",
      },
      toolName: "list",
    });
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    const parts = (await stateStore.readSnapshot()).sessions[0]?.messages[0]
      ?.parts;
    expect(parts).toEqual([
      {
        call: {
          id: "call_bash_0",
          input: { command: "sleep 10" },
          name: "bash",
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_bash_0",
          error: "failed",
          output: "stderr text",
        },
        type: "tool-result",
      },
      {
        call: {
          id: "call_bash_1",
          input: { command: "sleep 10" },
          name: "bash",
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_bash_1",
          error: "timed out",
          output: "partial output",
        },
        type: "tool-result",
      },
      {
        call: {
          id: "call_bash_2",
          input: { command: "sleep 10" },
          name: "bash",
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_bash_2",
          error: "cancelled",
          output: "partial output",
        },
        type: "tool-result",
      },
      {
        call: {
          id: "call_bash_3",
          input: { command: "sleep 10" },
          name: "bash",
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_bash_3",
          error: "exit code 1",
          output: "partial output",
        },
        type: "tool-result",
      },
      {
        call: {
          id: "call_list_error",
          input: { path: "/private" },
          name: "list",
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_list_error",
          error: "permission denied",
          output: "",
        },
        type: "tool-result",
      },
    ]);
  });

  it("never projects internal selector or todo tools into the streaming transcript", async () => {
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
      content: "Working.",
      delta: "Working.",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 1,
    });
    for (const [index, toolName] of [
      "select_tools",
      "todo_read",
      "todo_write",
    ].entries()) {
      const callId = `call_todo_${String(index)}`;
      streamBridge.publish("run/run_1", "run.tool.start", {
        callId,
        params: toolName === "todo_write" ? { todos: [] } : {},
        runId: "run_1",
        sessionId: "session_1",
        timestamp: index * 2 + 2,
        toolName,
      });
      streamBridge.publish("run/run_1", "run.tool.result", {
        callId,
        result: { output: "No todos.", status: "success" },
        runId: "run_1",
        sessionId: "session_1",
        timestamp: index * 2 + 3,
      });
    }
    streamBridge.end("run/run_1");

    projection.start();
    await projection.done;

    const snapshot = await stateStore.readSnapshot();
    expect(snapshot.sessions[0]?.messages[0]?.parts).toEqual([
      { text: "Working.", type: "text" },
    ]);
    const publishedEvents = publish.mock.calls.map((call): unknown => call[0]);
    expect(JSON.stringify(publishedEvents)).not.toContain('"tool-call"');
  });

  it.each(["success", "error"] as const)(
    "hides a %s todo result even when its start event is missing",
    async (status) => {
      const streamBridge = createInMemoryStreamBridge({
        heartbeatIntervalMs: 0,
      });
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
        content: "Visible text.",
        delta: "Visible text.",
        runId: "run_1",
        sessionId: "session_1",
        timestamp: 1,
      });
      streamBridge.publish("run/run_1", "run.tool.result", {
        callId: "call_todo_without_start",
        result: {
          ...(status === "error" ? { error: { message: "invalid" } } : {}),
          output: "Hidden todo output",
          status,
        },
        runId: "run_1",
        sessionId: "session_1",
        timestamp: 2,
        toolName: "todo_write",
      });
      streamBridge.end("run/run_1");

      projection.start();
      await projection.done;

      const snapshot = await stateStore.readSnapshot();
      expect(snapshot.sessions[0]?.messages[0]?.parts).toEqual([
        { text: "Visible text.", type: "text" },
      ]);
      expect(JSON.stringify(publish.mock.calls)).not.toContain(
        "Hidden todo output",
      );
    },
  );

  it("treats a cancelled run as an interruption and completes partial output", async () => {
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
      content: "partial answer",
      delta: "partial answer",
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 3,
    });
    streamBridge.publish("run/run_1", "run.updated", {
      run: {
        createdAt: 1,
        endedAt: 4,
        error: "run aborted",
        runId: "run_1",
        sessionId: "session_1",
        startedAt: 2,
        status: "cancelled",
        terminalReason: "cancelled",
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
          terminalReason: "cancelled",
        },
      ],
      sessions: [
        {
          messages: [
            {
              completedAt: "2026-05-26T00:00:01.000Z",
              finishReason: "cancelled",
              id: "message_assistant",
              parts: [{ text: "partial answer", type: "text" }],
              role: "assistant",
              status: "completed",
            },
          ],
        },
      ],
      status: { kind: "idle" },
    });
    const publishedEvents = publish.mock.calls.map((call): unknown => call[0]);
    expect(publishedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run_1",
          sessionId: "session_1",
          type: "run.interrupted",
        }),
      ]),
    );
    expect(
      publishedEvents.some(
        (event) =>
          isRecord(event) &&
          event.type === "runtime.updated" &&
          isRecord(event.status) &&
          event.status.kind === "error",
      ),
    ).toBe(false);
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
