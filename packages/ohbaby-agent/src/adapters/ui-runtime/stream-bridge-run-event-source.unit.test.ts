import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "../../core/lifecycle/index.js";
import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";
import { createStreamBridgeRunEventSource } from "./stream-bridge-run-event-source.js";

async function nextEvent(
  iterator: AsyncIterator<LifecycleEvent>,
): Promise<LifecycleEvent> {
  const item = await iterator.next();
  if (item.done) {
    throw new Error("expected lifecycle event");
  }
  return item.value;
}

describe("createStreamBridgeRunEventSource", () => {
  it("translates automatic compaction progress events from the run stream", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();

    streamBridge.publish("run/run_1", "run.context.compacting", {
      contextScopeId: "subagent_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
    });

    await expect(nextEvent(iterator)).resolves.toEqual({
      contextScopeId: "subagent_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      type: "context:compacting",
    });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("preserves context composition on prepared events", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();
    const composition = {
      "system-prompt": 10,
      "builtin-tools": 20,
      mcp: 30,
      skills: 40,
      conversation: 50,
      "summarized-conversation": 60,
      "subagent-exchanges": 70,
    };

    streamBridge.publish("run/run_1", "run.context.prepared", {
      composition,
      hasSummary: true,
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      usage: {
        contextLimit: 1_000,
        currentTokens: 280,
        modelId: "fake-model",
        remainingTokens: 720,
        usageRatio: 0.28,
      },
    });

    await expect(nextEvent(iterator)).resolves.toMatchObject({
      composition,
      hasSummary: true,
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      type: "context:prepared",
    });

    streamBridge.publish("run/run_1", "run.context.prepared", {
      composition: { ...composition, conversation: 50.5 },
      hasSummary: true,
      sessionId: "session_1",
      step: 3,
      timestamp: 124,
      usage: {
        contextLimit: 1_000,
        currentTokens: 281,
        modelId: "fake-model",
        remainingTokens: 719,
        usageRatio: 0.281,
      },
    });
    const malformed = await nextEvent(iterator);
    expect(malformed).toMatchObject({ step: 3, type: "context:prepared" });
    expect(malformed).not.toHaveProperty("composition");

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("translates llm start events from the run stream", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();

    streamBridge.publish("run/run_1", "run.llm.start", {
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
    });

    await expect(nextEvent(iterator)).resolves.toMatchObject({
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      type: "llm:start",
    });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("translates retry events from the run stream", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();

    streamBridge.publish("run/run_1", "run.llm.retrying", {
      attempt: 1,
      delayMs: 500,
      maxRetries: 5,
      reason: "rate_limit",
      sessionId: "session_1",
      step: 3,
      timestamp: 123,
    });

    await expect(nextEvent(iterator)).resolves.toMatchObject({
      attempt: 1,
      delayMs: 500,
      maxRetries: 5,
      reason: "rate_limit",
      sessionId: "session_1",
      step: 3,
      timestamp: 123,
      type: "llm:retrying",
    });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("preserves canonical cache-aware usage on llm completion events", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();

    streamBridge.publish("run/run_1", "run.llm.complete", {
      finishReason: "stop",
      sessionId: "session_1",
      step: 4,
      timestamp: 123,
      tokenUsage: {
        inputBreakdown: {
          cacheRead: 70,
          cacheWrite: 10,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 20,
        },
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      },
    });

    await expect(nextEvent(iterator)).resolves.toEqual({
      completeMessage: { content: "", role: "assistant" },
      finishReason: "stop",
      sessionId: "session_1",
      step: 4,
      timestamp: 123,
      tokenUsage: {
        inputBreakdown: {
          cacheRead: 70,
          cacheWrite: 10,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 20,
        },
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      },
      type: "llm:complete",
    });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("translates reasoning events from the run stream", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();

    streamBridge.publish("run/run_1", "run.llm.reasoning.delta", {
      content: "think more",
      delta: "more",
      messageId: "message_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
    });
    streamBridge.publish("run/run_1", "run.llm.reasoning.end", {
      content: "think more",
      messageId: "message_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 124,
    });

    await expect(nextEvent(iterator)).resolves.toEqual({
      content: "think more",
      delta: "more",
      messageId: "message_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      type: "llm:reasoning-delta",
    });
    await expect(nextEvent(iterator)).resolves.toEqual({
      content: "think more",
      messageId: "message_1",
      sessionId: "session_1",
      step: 2,
      timestamp: 124,
      type: "llm:reasoning-end",
    });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("translates stream bridge tool events and skips events without a session id", async () => {
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();

    streamBridge.publish("run/run_1", "run.tool.start", {
      callId: "call_1",
      params: { path: "README.md" },
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      toolName: "read",
    });

    await expect(nextEvent(iterator)).resolves.toMatchObject({
      callId: "call_1",
      params: { path: "README.md" },
      sessionId: "session_1",
      step: 2,
      timestamp: 123,
      toolName: "read",
      type: "tool:start",
    });

    streamBridge.publish("run/run_1", "run.tool.start", {
      callId: "missing_session",
      toolName: "read",
    });
    streamBridge.publish("run/run_1", "run.tool.result", {
      callId: "call_1",
      params: { path: "README.md" },
      result: { callId: "call_1", output: "ok", status: "success" },
      sessionId: "session_1",
      step: 2,
      timestamp: 456,
      toolName: "read",
    });

    await expect(nextEvent(iterator)).resolves.toMatchObject({
      callId: "call_1",
      result: { callId: "call_1", output: "ok", status: "success" },
      sessionId: "session_1",
      step: 2,
      timestamp: 456,
      toolName: "read",
      type: "tool:result",
    });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});
