import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createContextManager } from "../../../packages/ohbaby-agent/src/core/context/index.js";
import {
  Lifecycle,
  type LifecycleEvent,
} from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type { InterfaceProviderStreamEvent } from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import type { ToolSchedulerInstance } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createHeuristicTokenCounter } from "../../../packages/ohbaby-agent/src/services/llm-model/tokenCounting.js";
import { createContextSummaryClient } from "../../../packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.js";

describe("Context compaction through Lifecycle", () => {
  it("ends a failed summary run with completed tools intact and permits a fresh run", async () => {
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    for (const [index, size] of [12000, 12000, 10000].entries()) {
      const message = await messages.createMessage({
        sessionId: "s",
        role: index === 1 ? "assistant" : "user",
        agent: "primary",
      });
      await messages.appendPart(message.id, {
        type: "text",
        text: "x".repeat(size),
      });
    }
    const toolMessage = await messages.createMessage({
      sessionId: "s",
      role: "assistant",
      agent: "primary",
    });
    await messages.appendPart(toolMessage.id, {
      type: "tool",
      callId: "completed-read",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "notes.txt" },
        output: "preserved result",
      },
    });
    let failSummary = true;
    const purposes: string[] = [];
    const llm: LLMClientInstance = {
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        async streamResponse(request) {
          purposes.push(request.purpose ?? "unknown");
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            yield {
              textDelta:
                request.purpose === "context-summary"
                  ? "Stored task checkpoint"
                  : "Continued without repeating tools",
              finishReason:
                request.purpose === "context-summary" && failSummary
                  ? "length"
                  : "stop",
              tokenUsage: {
                inputTokens: 1000,
                outputTokens: 10,
                totalTokens: 1010,
              },
            };
          })();
        },
      },
      config: {
        provider: "test",
        interfaceProvider: "openai-compatible",
        model: "m",
        apiKeyEnv: "UNUSED_TEST_KEY",
        baseUrl: "https://example.invalid/v1",
        temperature: 0,
        maxTokens: 1024,
        modelProfiles: [
          {
            model: "m",
            contextWindowTokens: 64000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
    };
    const context = createContextManager({
      bus,
      messageManager: messages,
      memory: { load: async () => ({ global: "", project: "", merged: "" }) },
      systemPromptProvider: { build: async () => "" },
      tokenCounter: {
        ...createHeuristicTokenCounter({ defaultLimit: 64000 }),
        estimateTokens: (text) => text.length,
      },
      compressionThreshold: 0.4,
      llmClient: createContextSummaryClient(llm),
    });
    const executeBatch = vi.fn<ToolSchedulerInstance["executeBatch"]>();
    const lifecycle = new Lifecycle({
      contextManager: context,
      messageManager: messages,
      llmClient: llm,
      toolScheduler: { executeBatch } as unknown as ToolSchedulerInstance,
    });
    const before = await messages.listBySession("s");
    async function run(runId: string) {
      const events: LifecycleEvent[] = [];
      const loop = lifecycle.run({
        runId,
        sessionId: "s",
        modelId: "m",
        directory: "/repo",
      });
      for (;;) {
        const next = await loop.next();
        if (next.done) return { result: next.value, events };
        events.push(next.value);
      }
    }
    const failed = await run("failed-run");
    expect(failed.result).toMatchObject({
      success: false,
      terminalReason: "context_compaction_failed",
    });
    expect(purposes).toEqual(["context-summary"]);
    expect(await messages.listBySession("s")).toEqual(before);
    expect(executeBatch).not.toHaveBeenCalled();

    failSummary = false;
    const resumed = await run("new-run");
    expect(resumed.result).toMatchObject({
      success: true,
      finalResponse: "Continued without repeating tools",
    });
    expect(purposes).toEqual([
      "context-summary",
      "context-summary",
      "agent-step",
    ]);
    expect(executeBatch).not.toHaveBeenCalled();
    const saved = await messages.listBySession("s");
    expect(
      saved.find((message) => message.info.id === toolMessage.id)?.parts,
    ).toEqual(before.at(-1)?.parts);
    const summaries = saved.filter((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" &&
          part.metadata?.kind === "context-summary" &&
          part.time?.compacted === undefined,
      ),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].info).toMatchObject({
      modelRequests: [
        {
          purpose: "context-summary",
          outcome: "success",
          messageId: summaries[0].info.id,
        },
      ],
    });
    const prepared = resumed.events.find(
      (event) => event.type === "context:prepared",
    );
    expect(prepared).toMatchObject({ compaction: { status: "compacted" } });
    if (prepared?.type === "context:prepared") {
      expect(prepared.composition?.["summarized-conversation"]).toBeGreaterThan(
        0,
      );
      expect(prepared.usage.currentTokens).toBeLessThan(34000);
    }
  });
});
