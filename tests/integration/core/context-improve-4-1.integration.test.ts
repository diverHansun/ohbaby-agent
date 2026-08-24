import { describe, expect, it, vi } from "vitest";
import type { UiEvent, UiSnapshot } from "ohbaby-sdk";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type PreparedModelRequest,
  type ContextUsage,
  type MemoryReader,
  type SystemPromptProvider,
  type TokenCounter,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import { estimateWireHeuristic } from "../../../packages/ohbaby-agent/src/core/context/token-estimation.js";
import { Lifecycle } from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type {
  LLMClientInstance,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { ToolSchedulerInstance } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createInProcessUiBackendClient } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function providerStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* () {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function fakeLlmClient(input: {
  readonly batches: readonly (readonly ProviderStreamEvent[])[];
  readonly contextWindowTokens?: number;
  readonly requests: ProviderRequest[];
}): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;
  return {
    config: {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      contextWindowTokens: input.contextWindowTokens ?? 100_000,
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      provider: "fake",
      temperature: 0,
    },
    provider: {
      client: { kind: "fake" },
      id: "fake",
      isAbortError: () => false,
      kind: "openai-compatible",
      streamChatCompletion(request) {
        input.requests.push(request);
        const events = input.batches[nextBatch++];
        if (!events) {
          return Promise.reject(new Error("No fake response configured"));
        }
        return Promise.resolve(providerStream(events));
      },
    },
  };
}

async function consumeLifecycle(loop: ReturnType<Lifecycle["run"]>): Promise<{
  readonly result: Awaited<ReturnType<typeof loop.next>>["value"];
  readonly usages: ContextUsage[];
}> {
  const usages: ContextUsage[] = [];
  let next = await loop.next();
  while (!next.done) {
    if (next.value.type === "context:prepared") {
      usages.push(next.value.usage);
    }
    next = await loop.next();
  }
  return { result: next.value, usages };
}

describe("context improve-4.1 integration", () => {
  it("derives prompt names, measurement schemas, and provider schemas from one resolved tool set", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const appendUser = async (sessionId: string): Promise<void> => {
      const message = await messageManager.createMessage({
        agent: "build",
        role: "user",
        sessionId,
      });
      await messageManager.appendPart(message.id, {
        text: "Use the available tool if needed",
        type: "text",
      });
    };
    await appendUser("session_regular");
    await appendUser("session_final");
    const tokenCounter = {
      estimateTokens: (content: string): number => content.length,
      getLimit: (): number => 100_000,
    } satisfies TokenCounter;
    const systemPromptProvider = {
      build: vi
        .fn<SystemPromptProvider["build"]>()
        .mockImplementation((input) =>
          Promise.resolve(`Available tools: ${input.toolNames.join(", ")}`),
        ),
    } satisfies SystemPromptProvider;
    const measurements: PreparedModelRequest[] = [];
    const contextManager = createContextManager({
      bus,
      llmClient: {
        generateSummary: vi
          .fn<ContextLLMClient["generateSummary"]>()
          .mockResolvedValue("summary"),
      },
      memory: {
        load: vi
          .fn()
          .mockResolvedValue({ global: "", merged: "", project: "" }),
      } satisfies MemoryReader,
      messageManager,
      onRequestMeasured: (request) => measurements.push(request),
      systemPromptProvider,
      tokenCounter,
    });
    const updateCalibrationFactor = vi.spyOn(
      contextManager,
      "updateCalibrationFactor",
    );
    const resolvedTools = [
      {
        function: {
          description: "Read one file",
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];
    const resolveTools = vi.fn().mockResolvedValue(resolvedTools);
    const requests: ProviderRequest[] = [];
    const lifecycle = new Lifecycle({
      contextManager,
      llmClient: fakeLlmClient({
        batches: [
          [{ finishReason: "stop", textDelta: "regular" }],
          [
            {
              finishReason: "stop",
              textDelta: "final",
              tokenUsage: {
                inputTokens: 777,
                outputTokens: 10,
                totalTokens: 787,
              },
            },
          ],
        ],
        requests,
      }),
      messageManager,
      resolveTools,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const regular = await consumeLifecycle(
      lifecycle.run({
        directory: "/repo",
        modelId: "fake-model",
        sessionId: "session_regular",
      }),
    );
    const regularMeasurement = measurements.at(-1);
    const final = await consumeLifecycle(
      lifecycle.run({
        directory: "/repo",
        maxSteps: 1,
        modelId: "fake-model",
        sessionId: "session_final",
      }),
    );
    const finalMeasurement = measurements.at(-1);

    expect(resolveTools).toHaveBeenCalledTimes(2);
    expect(requests[0]?.tools).toEqual(resolvedTools);
    expect({
      messages: requests[0]?.messages,
      tools: requests[0]?.tools,
    }).toEqual(regularMeasurement);
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "Available tools: read_file",
    );
    expect(regular.usages[0]?.currentTokens).toBe(
      estimateWireHeuristic(
        requests[0]?.messages ?? [],
        tokenCounter,
        resolvedTools,
      ),
    );
    expect(requests[1]?.tools).toEqual([]);
    expect({
      messages: requests[1]?.messages,
      tools: requests[1]?.tools,
    }).toEqual(finalMeasurement);
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      "Available tools: read_file",
    );
    expect(final.usages[0]?.currentTokens).toBe(
      estimateWireHeuristic(requests[1]?.messages ?? [], tokenCounter, []),
    );
    expect(updateCalibrationFactor).toHaveBeenCalledWith(
      "session_final",
      777,
      estimateWireHeuristic(requests[1]?.messages ?? [], tokenCounter, []),
    );
  });

  it("projects manual compact usageAfter into the next status without another provider request", async () => {
    const bus = createBus();
    const projectRoot = process.cwd();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    for (const [index, role] of ["user", "assistant", "user"].entries()) {
      const message = await messageManager.createMessage({
        agent: "build",
        role: role as "assistant" | "user",
        sessionId: "session_1",
      });
      await messageManager.appendPart(message.id, {
        text: `${String(index)} ${"long context ".repeat(40)}`,
        type: "text",
      });
    }
    const requests: ProviderRequest[] = [];
    const snapshot: UiSnapshot = {
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-08-22T00:00:00.000Z",
          id: "session_1",
          messages: [],
          projectRoot,
          title: "Primary",
          updatedAt: "2026-08-22T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    };
    const client = createInProcessUiBackendClient({
      bus,
      initialSnapshot: snapshot,
      llmClient: fakeLlmClient({
        batches: [
          [
            {
              finishReason: "stop",
              textDelta: "<state_snapshot>short</state_snapshot>",
            },
          ],
        ],
        requests,
      }),
      messageManager,
      workdir: projectRoot,
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => events.push(event));

    const staticUsage = await client.getContextWindowUsage({
      sessionId: "session_1",
    });
    const compact = await client.compactSession({ sessionId: "session_1" });
    const postCompactMessage = await messageManager.createMessage({
      agent: "build",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(postCompactMessage.id, {
      text: "new unmeasured history ".repeat(1_000),
      type: "text",
    });
    await client.executeCommand({
      argv: [],
      clientInvocationId: "status_after_compact",
      commandId: "status",
      path: ["status"],
      raw: "/status",
      rawArgs: "",
      sessionId: "session_1",
      surface: "tui",
    });
    const windowEvent = events.find(
      (event): event is Extract<UiEvent, { type: "context.window.updated" }> =>
        event.type === "context.window.updated",
    );
    const statusEvent = events.findLast(
      (
        event,
      ): event is Extract<UiEvent, { type: "command.result.delivered" }> =>
        event.type === "command.result.delivered" &&
        event.output?.kind === "data" &&
        event.output.subject === "status",
    );

    expect(compact.status).toBe("compacted");
    expect(staticUsage).toMatchObject({
      contextWindowTokens: compact.usageBefore.contextLimit,
      currentTokens: compact.usageBefore.currentTokens,
      modelId: compact.usageBefore.modelId,
    });
    expect(compact.usageAfter.currentTokens).toBeLessThan(
      compact.usageBefore.currentTokens,
    );
    expect(windowEvent?.usage.currentTokens).toBe(
      compact.usageAfter.currentTokens,
    );
    expect(statusEvent?.output).toMatchObject({
      data: { contextWindow: windowEvent?.usage },
      kind: "data",
      subject: "status",
    });
    if (statusEvent?.output?.kind === "data") {
      expect(statusEvent.output.data).not.toHaveProperty("context");
    }
    expect(requests).toHaveLength(1);
  });
});
