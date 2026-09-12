import type OpenAI from "openai";
import { describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { createOpenAIResponsesProvider } from "./openai-responses.js";
import { createBus } from "../../bus/index.js";
import { createContextManager } from "../../core/context/index.js";
import {
  Lifecycle,
  type LifecycleEvent,
  type LifecycleResult,
} from "../../core/lifecycle/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
  type MessageManager,
} from "../../core/message/index.js";
import {
  createToolScheduler,
  type ToolSchedulerInstance,
} from "../../core/tool-scheduler/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createPromptCacheUsageTracker } from "../../adapters/ui-inprocess/prompt-cache-usage.js";

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
};
function final(
  output: unknown[],
  rawUsage: unknown = usage,
): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id: "resp-1",
      status: "completed",
      output,
      usage: rawUsage,
      previous_response_id: null,
      store: false,
    },
  };
}
function calls(): Record<string, unknown>[] {
  const output = [
    {
      id: "item-b",
      type: "function_call",
      call_id: "call-b",
      name: "lookup",
      arguments: '{"q":"b"}',
      status: "completed",
    },
    {
      id: "item-a",
      type: "function_call",
      call_id: "call-a",
      name: "lookup",
      arguments: '{"q":"a"}',
      status: "completed",
    },
  ];
  return [
    ...[output[1], output[0]].flatMap((item) => {
      const ref = {
        output_index: item.id === "item-a" ? 9 : 3,
        item_id: item.id,
      };
      return [
        {
          type: "response.output_item.added",
          ...ref,
          item: { ...item, status: "in_progress", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          ...ref,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          ...ref,
          arguments: item.arguments,
        },
        { type: "response.output_item.done", ...ref, item },
      ];
    }),
    final(output),
  ];
}
function text(rawUsage: unknown = usage): Record<string, unknown>[] {
  const part = {
    type: "output_text",
    text: "done",
    annotations: [],
    logprobs: [],
  };
  const item = {
    id: "msg-1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const ref = { item_id: "msg-1", output_index: 0, content_index: 0 };
  return [
    {
      type: "response.output_item.added",
      ...ref,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...ref,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...ref, delta: "done", logprobs: [] },
    { type: "response.output_text.done", ...ref, text: "done", logprobs: [] },
    { type: "response.content_part.done", ...ref, part },
    { type: "response.output_item.done", ...ref, item },
    final([item], rawUsage),
  ];
}

interface Harness {
  run(): Promise<LifecycleResult>;
  events: LifecycleEvent[];
  execute: Mock<(params: Record<string, unknown>) => { output: string }>;
  executeBatch: MockInstance<ToolSchedulerInstance["executeBatch"]>;
  beforeToolCall: Mock<() => Promise<undefined>>;
  create: MockInstance<OpenAI["responses"]["create"]>;
  chat: MockInstance<OpenAI["chat"]["completions"]["create"]>;
  messageManager: MessageManager;
}

async function setup(
  batches: unknown[][],
  abort?: AbortController,
): Promise<Harness> {
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const user = await messageManager.createMessage({
    sessionId: "session",
    role: "user",
    agent: "build",
  });
  await messageManager.appendPart(user.id, {
    type: "text",
    text: "look up a and b",
  });
  const contextManager = createContextManager({
    bus,
    messageManager,
    llmClient: {
      generateSummary: (): Promise<string> => Promise.resolve("unused"),
    },
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: {
      build: (): Promise<string> => Promise.resolve("system instruction"),
    },
    tokenCounter: {
      estimateTokens: (value: string): number => Math.ceil(value.length / 4),
      getLimit: (): number => 100_000,
    },
  });
  const scheduler = createToolScheduler({
    bus,
    permission: { ask: () => "once" },
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  const execute = vi.fn((params: Record<string, unknown>) => ({
    output: JSON.stringify(params),
  }));
  scheduler.register({
    category: "readonly",
    source: "builtin",
    name: "lookup",
    description: "Lookup",
    parametersJsonSchema: {
      type: "object",
      properties: { q: { type: "string" } },
    },
    execute,
  });
  const provider = createOpenAIResponsesProvider({
    id: "openai",
    apiKey: "test",
    baseUrl: "https://api.openai.com/v1",
  });
  const create = vi
    .spyOn(provider.client.responses, "create")
    .mockImplementation(() => {
      const batch = batches.shift();
      if (!batch) throw new Error("Unexpected request/retry");
      return Promise.resolve(
        (async function* (): AsyncGenerator {
          for (const event of batch) yield await Promise.resolve(event);
          abort?.abort();
        })(),
      ) as never;
    });
  const chat = vi.spyOn(provider.client.chat.completions, "create");
  const beforeToolCall = vi.fn(() => Promise.resolve(undefined));
  const executeBatch = vi.spyOn(scheduler, "executeBatch");
  const lifecycle = new Lifecycle({
    contextManager,
    messageManager,
    toolScheduler: scheduler,
    llmClient: {
      provider,
      config: {
        model: "responses-test",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        interfaceProvider: "openai-responses",
        temperature: 0,
        maxTokens: 128,
      },
    },
  });
  const events: LifecycleEvent[] = [];
  async function run(): Promise<LifecycleResult> {
    const loop = lifecycle.run(
      {
        sessionId: "session",
        directory: "/workspace/test",
        modelId: "responses-test",
        signal: abort?.signal,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: {
                type: "object",
                properties: { q: { type: "string" } },
              },
            },
          },
        ],
      },
      { beforeToolCall },
    );
    for (;;) {
      const next = await loop.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  }
  return {
    run,
    events,
    execute,
    executeBatch,
    beforeToolCall,
    create,
    chat,
    messageManager,
  };
}

describe("Responses adapter through llm-client and Lifecycle", () => {
  it.each(["max_output_tokens", "future_reason"])(
    "blocks tools when completed function output carries incomplete_details: %s",
    async (reason) => {
      const stream = calls();
      const completed = stream.at(-1);
      if (
        !completed ||
        typeof completed.response !== "object" ||
        completed.response === null
      )
        throw new Error("Expected completed response fixture");
      stream[stream.length - 1] = {
        ...completed,
        response: { ...completed.response, incomplete_details: { reason } },
      };
      const harness = await setup([stream, text()]);
      expect(await harness.run()).toMatchObject({
        success: false,
        finishReason: "error",
        terminalReason: "provider_stream_interrupted",
      });
      expect(harness.beforeToolCall).not.toHaveBeenCalled();
      expect(harness.executeBatch).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(
        harness.events.some((event) => event.type === "llm:complete"),
      ).toBe(false);
      expect(
        harness.events.some(
          (event) =>
            event.type === "turn:end" && event.finishReason !== "error",
        ),
      ).toBe(false);
      const messages = await harness.messageManager.listBySession("session");
      const assistants = messages.flatMap((message) =>
        message.info.role === "assistant" ? [message.info] : [],
      );
      expect(assistants).toMatchObject([{ finish: "error" }]);
      expect(assistants[0]?.error).toBeDefined();
      expect(harness.create).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["before", "after"])(
    "never schedules function calls when reasoning arrives %s their deltas",
    async (position) => {
      const stream = calls();
      stream.splice(position === "before" ? 0 : stream.length - 1, 0, {
        type: "response.reasoning_text.delta",
        delta: "unsupported",
      });
      const harness = await setup([stream]);
      let failed = false;
      try {
        const result = await harness.run();
        failed = !result.success;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(harness.beforeToolCall).not.toHaveBeenCalled();
      expect(harness.executeBatch).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(
        harness.events.some((event) => event.type === "llm:complete"),
      ).toBe(false);
      expect(
        harness.events.some(
          (event) =>
            event.type === "turn:end" && event.finishReason !== "error",
        ),
      ).toBe(false);
      const messages = await harness.messageManager.listBySession("session");
      const assistants = messages.flatMap((message) =>
        message.info.role === "assistant" ? [message.info] : [],
      );
      expect(assistants).toMatchObject([{ finish: "error" }]);
      expect(assistants[0]?.error).toBeDefined();
      expect(harness.create).toHaveBeenCalledTimes(1);
      expect(harness.chat).not.toHaveBeenCalled();
    },
  );
  it("cancels after function deltas without retries or tool execution", async () => {
    const abort = new AbortController();
    const harness = await setup([calls().slice(0, 2)], abort);
    expect(await harness.run()).toMatchObject({
      success: false,
      terminalReason: "cancelled",
    });
    expect(harness.beforeToolCall).not.toHaveBeenCalled();
    expect(harness.executeBatch).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.create).toHaveBeenCalledTimes(1);
  });
  it("roundtrips two functions through the real context serializer and retains inclusive usage", async () => {
    const harness = await setup([calls(), text()]);
    const result = await harness.run();
    expect(result).toMatchObject({
      success: true,
      finalResponse: "done",
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
        usageComplete: true,
        inputBreakdown: { uncached: 100, cacheRead: 80, cacheWrite: 20 },
      },
    });
    expect(harness.execute).toHaveBeenCalledTimes(2);
    const second = harness.create.mock.calls[1]?.[0];
    expect(second.store).toBe(false);
    expect(second.input).toEqual(
      expect.arrayContaining([
        {
          type: "function_call",
          call_id: "call-a",
          name: "lookup",
          arguments: '{"q":"a"}',
        },
        {
          type: "function_call",
          call_id: "call-b",
          name: "lookup",
          arguments: '{"q":"b"}',
        },
        {
          type: "function_call_output",
          call_id: "call-a",
          output: '{"q":"a"}',
        },
        {
          type: "function_call_output",
          call_id: "call-b",
          output: '{"q":"b"}',
        },
      ]),
    );
    expect(harness.chat).not.toHaveBeenCalled();
    const tracker = createPromptCacheUsageTracker();
    expect(tracker.record("session", result.usage)).toEqual({
      sessionId: "session",
      accountedInputTokens: 200,
      cacheReadTokens: 80,
      cacheReadShare: 0.4,
    });
    const messages = await harness.messageManager.listBySession("session");
    const metadata = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text" && part.text === "done")
      .map((part) => readTokenUsageMetadata(part.metadata));
    expect(metadata).toEqual([
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputBreakdown: {
          uncached: 50,
          cacheRead: 40,
          cacheWrite: 10,
          observed: { cacheRead: true, cacheWrite: true },
        },
      },
    ]);
  });
  it("preserves downstream completeness when a later step lacks cache details", async () => {
    const harness = await setup([
      calls(),
      text({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }),
    ]);
    const result = await harness.run();
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      usageComplete: true,
    });
    expect(
      createPromptCacheUsageTracker().record("session", result.usage)
        .cacheReadShare,
    ).toBeNull();
  });
});
