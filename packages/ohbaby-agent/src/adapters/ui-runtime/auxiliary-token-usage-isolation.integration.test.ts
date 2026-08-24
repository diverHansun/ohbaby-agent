import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import type { ContextManager } from "../../core/context/index.js";
import { Lifecycle } from "../../core/lifecycle/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
} from "../../core/lifecycle/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import { streamChatCompletion } from "../../core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import type { ToolSchedulerInstance } from "../../core/tool-scheduler/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import { generateSessionTitle } from "../../services/session/title-generator.js";
import { createContextSummaryClient } from "./prompt-context.js";

function providerStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncIterable<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

async function consume(
  loop: AsyncGenerator<LifecycleEvent, LifecycleResult, void>,
): Promise<LifecycleResult> {
  let next = await loop.next();
  while (!next.done) {
    next = await loop.next();
  }
  return next.value;
}

describe("auxiliary token usage isolation", () => {
  it("keeps summary and title usage out of a scoped agent-step aggregate and calibration", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const batches: InterfaceProviderStreamEvent[][] = [
      [
        {
          finishReason: "stop",
          textDelta: "summary",
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
          },
        },
      ],
      [
        {
          finishReason: "stop",
          textDelta: "Auxiliary title",
          tokenUsage: {
            inputTokens: 50,
            outputTokens: 3,
            totalTokens: 53,
          },
        },
      ],
      [
        {
          finishReason: "stop",
          textDelta: "done",
          tokenUsage: {
            inputBreakdown: {
              cacheRead: 5,
              cacheWrite: 0,
              observed: { cacheRead: true, cacheWrite: false },
              uncached: 2,
            },
            inputTokens: 7,
            outputTokens: 2,
            totalTokens: 9,
          },
        },
      ],
    ];
    const llmClient: LLMClientInstance = {
      config: {
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        maxTokens: 128,
        model: "fake-model",
        provider: "fake",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        isAbortError: () => false,
        kind: "openai-compatible",
        streamChatCompletion(
          request,
        ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
          requests.push(request);
          const batch = batches.shift();
          if (!batch) {
            return Promise.reject(new Error("missing provider fixture"));
          }
          return Promise.resolve(providerStream(batch));
        },
      },
    };

    const summaryClient = createContextSummaryClient(llmClient);
    await expect(
      summaryClient.generateSummary({
        contextScopeId: "subagent_1",
        history: [],
        prompt: "summarize",
        sessionId: "child_session",
        systemPrompt: "system",
      }),
    ).resolves.toBe("summary");
    await expect(
      generateSessionTitle({
        firstUserMessage: "Name this child task",
        llmClient,
        sessionId: "child_session",
      }),
    ).resolves.toBe("Auxiliary title");

    const updateCalibrationFactor =
      vi.fn<ContextManager["updateCalibrationFactor"]>();
    const contextManager = {
      createRunPromptSnapshot: vi.fn().mockResolvedValue({
        memory: { global: "", merged: "", project: "" },
        systemPrompt: "stable",
      }),
      disposeScope: vi.fn(),
      prepareTurn: vi.fn().mockResolvedValue({
        assembledAt: 1,
        hasSummary: false,
        request: {
          messages: [{ content: "continue", role: "user" }],
          tools: undefined,
        },
        sentHeuristic: 42,
        usage: {
          contextLimit: 128_000,
          currentTokens: 42,
          modelId: "fake-model",
          remainingTokens: 127_958,
          usageRatio: 42 / 128_000,
        },
      }),
      resetTurnCompactionCount: vi.fn(),
      updateCalibrationFactor,
    } as unknown as ContextManager;
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
    });
    const lifecycle = new Lifecycle({
      contextManager,
      llmClient,
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn(),
      } as unknown as ToolSchedulerInstance,
    });

    const result = await consume(
      lifecycle.run({
        contextScopeId: "subagent_1",
        directory: "/workspace",
        isSubagent: true,
        modelId: "fake-model",
        sessionId: "child_session",
      }),
    );

    expect(requests).toHaveLength(3);
    expect(
      requests.map(({ contextScopeId, promptCache, purpose, sessionId }) => ({
        contextScopeId,
        promptCache: promptCache.strategy,
        purpose,
        sessionId,
      })),
    ).toEqual([
      {
        contextScopeId: "subagent_1",
        promptCache: "observe-only",
        purpose: "context-summary",
        sessionId: "child_session",
      },
      {
        contextScopeId: undefined,
        promptCache: "observe-only",
        purpose: "session-title",
        sessionId: "child_session",
      },
      {
        contextScopeId: "subagent_1",
        promptCache: "observe-only",
        purpose: "agent-step",
        sessionId: "child_session",
      },
    ]);
    expect(result.usage).toEqual({
      inputBreakdown: {
        cacheRead: 5,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 2,
      },
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      usageComplete: true,
    });
    expect(updateCalibrationFactor).toHaveBeenCalledOnce();
    expect(updateCalibrationFactor).toHaveBeenCalledWith(
      "child_session",
      7,
      42,
      "subagent_1",
    );

    batches.push([
      {
        finishReason: "stop",
        textDelta: "primary done",
        tokenUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      },
    ]);
    await consume(
      lifecycle.run({
        directory: "/workspace",
        isSubagent: false,
        modelId: "fake-model",
        sessionId: "primary_session",
      }),
    );
    expect(requests[3]).toMatchObject({
      promptCache: { strategy: "observe-only" },
      purpose: "agent-step",
      sessionId: "primary_session",
    });
    expect(requests[3]).not.toHaveProperty("contextScopeId");

    batches.push([{ finishReason: "stop", textDelta: "legacy" }]);
    for await (const _ of streamChatCompletion(llmClient, [
      { role: "user", content: "Legacy external call" },
    ])) {
      // Drain the shared-client legacy compatibility path.
    }
    expect(requests[4]).toMatchObject({
      promptCache: { strategy: "observe-only" },
    });
    expect(requests[4]).not.toHaveProperty("purpose");
    expect(requests[4]?.promptCache.key).toBeUndefined();
  });
});
