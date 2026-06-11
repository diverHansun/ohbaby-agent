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
