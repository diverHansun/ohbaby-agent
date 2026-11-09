import { testRunModel } from "../../../fixtures/model-fixtures.js";
import { type TestLifecycleSessionParams as LifecycleSessionParams } from "../../../fixtures/model-fixtures.js";
import { describe, expect, it } from "vitest";
import type {
  LifecycleEvent,
  LifecycleResult,
} from "../../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import { RunWorker } from "../../../../packages/ohbaby-agent/src/runtime/run-manager/worker.js";
import type {
  RunContext,
  RunLifecycle,
  RunRecord,
} from "../../../../packages/ohbaby-agent/src/runtime/run-manager/index.js";
import { createInMemoryStreamBridge } from "../../../../packages/ohbaby-agent/src/runtime/stream-bridge/index.js";
import { createStreamBridgeRunEventSource } from "../../../../packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.js";

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
      reasoningTokens: 10,
      totalTokens: 125,
    } as const;
    const lifecycle: RunLifecycle = {
      async *run(
        params: LifecycleSessionParams,
      ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
        await Promise.resolve();
        yield {
          messageSnapshot: { content: "done" },
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
      runModel: testRunModel("fake-model"),
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
