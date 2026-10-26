import {
  createTestContextManager as createContextManager,
  TestLifecycle as Lifecycle,
} from "../../../packages/ohbaby-agent/src/core/testing/model-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";

import { type LifecycleEvent } from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { LLMClientInstance } from "ohbaby-llm";
import type { InterfaceProviderStreamEvent } from "ohbaby-llm";
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
  it("continues one run through four automatic compactions as completed tool results grow", async () => {
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    for (let index = 0; index < 8; index++) {
      const message = await messages.createMessage({
        sessionId: "s",
        role: "assistant",
        agent: "primary",
      });
      await messages.appendPart(message.id, {
        type: "text",
        text: `${index}:` + "x".repeat(6000),
      });
    }
    let step = 0;
    let summaries = 0;
    const purposes: string[] = [];
    const llm: LLMClientInstance = {
      config: {
        provider: "test",
        interfaceProvider: "openai-compatible",
        model: "m",
        apiKeyEnv: "UNUSED_TEST_KEY",
        baseUrl: "https://example.invalid/v1",
        temperature: 0,
        maxTokens: 1024,
      },
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        async streamResponse(request) {
          purposes.push(request.purpose ?? "unknown");
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            if (request.purpose === "context-summary") {
              summaries++;
              yield {
                textDelta: "Task checkpoint; preserve completed read results",
                finishReason: "stop",
              };
            } else if (++step <= 3) {
              yield {
                toolCallDeltas: [
                  {
                    id: `read-${step}`,
                    index: 0,
                    name: "read",
                    argumentsDelta: "{}",
                  },
                ],
                finishReason: "tool_calls",
              };
            } else {
              yield {
                textDelta: "Completed after repeated compaction",
                finishReason: "stop",
              };
            }
          })();
        },
      },
    };
    const context = createContextManager({
      bus,
      messageManager: messages,
      memory: { load: async () => ({ global: "", project: "", merged: "" }) },
      systemPromptProvider: { build: async () => "" },
      tokenCounter: {
        ...createHeuristicTokenCounter({ defaultLimit: 128000 }),
        estimateTokens: (text) => text.length,
      },
      compressionThreshold: 0,
      llmClient: createContextSummaryClient(llm),
    });
    const executeBatch = vi.fn<ToolSchedulerInstance["executeBatch"]>(
      async (batch) => {
        const results = [];
        for (const [index, call] of batch.calls.entries()) {
          const result = {
            callId: call.callId,
            status: "success" as const,
            output: `${call.callId}:` + "y".repeat(30000),
            execution: {
              runId: call.runId,
              phase: "ended" as const,
              createdAt: 1,
              phaseStartedAt: 2,
              endedAt: 2,
              outcome: "success" as const,
            },
          };
          await batch.observer?.onCallSettled(call, index, result);
          results.push(result);
        }
        return results;
      },
    );
    const lifecycle = new Lifecycle({
      contextManager: context,
      messageManager: messages,
      llmClient: llm,
      toolScheduler: { executeBatch } as unknown as ToolSchedulerInstance,
      resolveTools: async () => ({
        requestTools: [{ name: "read", inputSchema: { type: "object" } }],
        definitions: [
          {
            name: "read",
            description: "Read fixture",
            parameters: { type: "object" },
            category: "readonly",
            source: "builtin",
          },
        ],
      }),
    });
    const events: LifecycleEvent[] = [];
    const run = lifecycle.run({
      runId: "one-run",
      sessionId: "s",
      modelId: "m",
      directory: "/repo",
    });
    for (;;) {
      const next = await run.next();
      if (next.done) {
        expect(next.value).toMatchObject({
          success: true,
          finalResponse: "Completed after repeated compaction",
        });
        break;
      }
      events.push(next.value);
    }
    expect(summaries).toBe(4);
    expect(purposes).toEqual(
      Array.from({ length: 4 }, () => ["context-summary", "agent-step"]).flat(),
    );
    expect(executeBatch).toHaveBeenCalledTimes(3);
    expect(
      executeBatch.mock.calls.flatMap(([batch]) =>
        batch.calls.map((call) => call.runId),
      ),
    ).toEqual(["one-run", "one-run", "one-run"]);
    expect(
      events.filter(
        (event) =>
          event.type === "context:prepared" &&
          event.compaction?.status === "compacted",
      ),
    ).toHaveLength(4);
    const history = await messages.listBySession("s");
    const summaryParts = history
      .flatMap((message) => message.parts)
      .filter((part) => part.metadata?.kind === "context-summary");
    expect(summaryParts).toHaveLength(4);
    expect(
      summaryParts.filter((part) => part.time?.compacted === undefined),
    ).toHaveLength(1);
    const tools = history
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool");
    expect(tools).toHaveLength(3);
    expect(
      tools.every(
        (part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          part.state.output.length > 30000,
      ),
    ).toBe(true);
  });
});
