import { describe, expect, it } from "vitest";
import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
} from "../../core/lifecycle/index.js";
import { RunWorker } from "../../runtime/run-manager/worker.js";
import type {
  RunContext,
  RunLifecycle,
  RunRecord,
} from "../../runtime/run-manager/index.js";
import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";
import { createStreamBridgeRunEventSource } from "./stream-bridge-run-event-source.js";

describe("token usage event transport", () => {
  it("round-trips cache-aware usage from a scoped lifecycle through worker and stream bridge", async () => {
    const tokenUsage = {
      inputBreakdown: {
        cacheRead: 70,
        cacheWrite: 10,
        observed: { cacheRead: true, cacheWrite: true },
        uncached: 20,
      },
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    } as const;
    const lifecycle: RunLifecycle = {
      async *run(
        params: LifecycleSessionParams,
      ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
        await Promise.resolve();
        yield {
          completeMessage: { content: "done", role: "assistant" },
          contextScopeId: params.contextScopeId,
          finishReason: "stop",
          sessionId: params.sessionId,
          step: 3,
          timestamp: 123,
          tokenUsage,
          type: "llm:complete",
        };
        return {
          finalResponse: "done",
          finishReason: "stop",
          success: true,
          usage: { ...tokenUsage, usageComplete: true },
        };
      },
    };
    const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const source = createStreamBridgeRunEventSource(streamBridge);
    const iterator = source.subscribeRunEvents("run_1")[Symbol.asyncIterator]();
    const abortController = new AbortController();
    const context: RunContext = {
      abortSignal: abortController.signal,
      contextScopeId: "subagent_1",
      directory: "/workspace",
      isSubagent: true,
      modelId: "fake-model",
      permissionProfileId: "interactive",
      runId: "run_1",
      sandboxLease: {} as RunContext["sandboxLease"],
      sessionId: "child_session",
      triggerSource: "user",
    };
    const run: RunRecord = {
      createdAt: 1,
      disconnectMode: "continue",
      multitaskStrategy: "reject",
      permissionProfileId: "interactive",
      runId: "run_1",
      sessionId: "child_session",
      status: "pending",
      triggerSource: "user",
    };
    const worker = new RunWorker(context, { lifecycle, streamBridge });

    const completion = worker.start({
      onRunning: () => Promise.resolve(),
      run,
    });
    const next = await iterator.next();

    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({
      contextScopeId: "subagent_1",
      sessionId: "child_session",
      step: 3,
      type: "llm:complete",
    });
    expect(
      (next.value as Extract<LifecycleEvent, { type: "llm:complete" }>)
        .tokenUsage,
    ).toEqual(tokenUsage);
    await expect(completion).resolves.toMatchObject({ status: "succeeded" });

    streamBridge.end("run/run_1");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});
