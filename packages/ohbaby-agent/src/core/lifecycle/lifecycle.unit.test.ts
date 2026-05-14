import { describe, expect, it, vi } from "vitest";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../../services/providers/index.js";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  Message,
} from "../message/index.js";
import type { MessageIdGenerator } from "../message/index.js";
import { Lifecycle } from "./index.js";
import type { LLMClientInstance } from "../llm-client/index.js";
import type {
  ToolCallResult,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";
import type { LifecycleEvent, LifecycleResult } from "./index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function createProviderStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    ProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createFakeLLMClient(
  events: readonly ProviderStreamEvent[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        _request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly ProviderStreamEvent[])[],
  requests: ProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        if (nextBatch >= eventBatches.length) {
          return Promise.reject(new Error("No fake LLM response configured"));
        }
        requests.push(request);
        const events = eventBatches[nextBatch];
        nextBatch += 1;
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createRejectingLLMClient(
  error: Error,
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.reject(error);
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createAbortingLLMClient(input: {
  readonly abort: () => void;
  readonly error: Error;
}): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            ProviderStreamEvent,
            void,
            unknown
          > {
            await Promise.resolve();
            yield { textDelta: "Partial" };
            input.abort();
            throw input.error;
          })(),
        );
      },
      isAbortError(error: unknown): boolean {
        return error === input.error;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

describe("Lifecycle.run", () => {
  it("yields streaming deltas and returns the final assistant response", async () => {
    const lifecycle = new Lifecycle({
      llmClient: createFakeLLMClient([
        { textDelta: "Hello" },
        {
          textDelta: " world",
          finishReason: "stop",
          tokenUsage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        },
      ]),
    });

    const events = [];
    const loop = lifecycle.run({
      sessionId: "session_test",
      messages: [{ role: "user", content: "Say hello" }],
    });

    let next = await loop.next();
    while (!next.done) {
      events.push(next.value);
      next = await loop.next();
    }

    expect(events.map((event) => event.type)).toEqual([
      "llm:start",
      "llm:delta",
      "llm:delta",
      "llm:complete",
    ]);
    expect(events[1]).toMatchObject({
      type: "llm:delta",
      delta: "Hello",
      content: "Hello",
    });
    expect(events[2]).toMatchObject({
      type: "llm:delta",
      delta: " world",
      content: "Hello world",
    });
    expect(next.value).toMatchObject({
      success: true,
      finishReason: "stop",
      finalResponse: "Hello world",
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
      },
    });
  });

  it("persists assistant message parts when a MessageManager is provided", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const partEvents: unknown[] = [];
    bus.subscribe(Message.Event.PartUpdated, (payload) => {
      partEvents.push(payload);
    });
    const user = await messageManager.createMessage({
      sessionId: "session_test",
      role: "user",
      agent: "default",
    });
    await messageManager.appendPart(user.id, {
      type: "text",
      text: "Say hello",
    });
    const lifecycle = new Lifecycle({
      llmClient: createFakeLLMClient([
        { textDelta: "Hello" },
        { textDelta: " world", finishReason: "stop" },
      ]),
      messageManager,
    });

    const loop = lifecycle.run({
      sessionId: "session_test",
      agent: "default",
      parentMessageId: user.id,
      messages: await messageManager.toModelMessages("session_test"),
    });

    let next = await loop.next();
    while (!next.done) {
      next = await loop.next();
    }

    await expect(
      messageManager.listBySession("session_test"),
    ).resolves.toMatchObject([
      {
        info: { id: "message_1", role: "user" },
        parts: [{ id: "part_1", type: "text", text: "Say hello" }],
      },
      {
        info: {
          id: "message_2",
          role: "assistant",
          parentId: "message_1",
          finish: "stop",
        },
        parts: [{ id: "part_2", type: "text", text: "Hello world" }],
      },
    ]);
    expect(partEvents).toMatchObject([
      { part: { id: "part_1", text: "Say hello" } },
      { part: { id: "part_2", text: "Hello" } },
      { part: { id: "part_2", text: "Hello world" }, delta: " world" },
    ]);
  });

  it("executes a tool call and sends the result into the next LLM step", async () => {
    const requests: ProviderRequest[] = [];
    const executeBatch = vi
      .fn<ToolSchedulerInstance["executeBatch"]>()
      .mockResolvedValue([
        {
          callId: "call_weather",
          output: "weather: sunny",
          status: "success",
        },
      ]);
    const toolScheduler = {
      executeBatch,
    } as unknown as ToolSchedulerInstance;
    const lifecycle = new Lifecycle({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"location":"NYC"}',
                  id: "call_weather",
                  index: 0,
                  name: "get_weather",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "It is sunny.", finishReason: "stop" }],
        ],
        requests,
      ),
      toolScheduler,
    });

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run({
        sessionId: "session_test",
        messages: [{ role: "user", content: "Check NYC weather" }],
      }),
    );

    expect(events).toEqual([
      "llm:start",
      "llm:complete",
      "tool:start",
      "tool:result",
      "step:complete",
      "llm:start",
      "llm:delta",
      "llm:complete",
    ]);
    expect(executeBatch).toHaveBeenCalledWith({
      calls: [
        expect.objectContaining({
          callId: "call_weather",
          params: { location: "NYC" },
          sessionId: "session_test",
          toolName: "get_weather",
        }),
      ],
    });
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "Check NYC weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_weather",
            type: "function",
            function: {
              arguments: '{"location":"NYC"}',
              name: "get_weather",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "weather: sunny",
        tool_call_id: "call_weather",
      },
    ]);
    expect(result).toMatchObject({
      finalResponse: "It is sunny.",
      finishReason: "stop",
      success: true,
    });
  });

  it("writes rejected tool results back to the next LLM step", async () => {
    const requests: ProviderRequest[] = [];
    const rejectedResult = {
      callId: "call_edit",
      error: {
        message: "Tool rejected by user: edit",
        type: "PermissionRejectedError",
      },
      status: "rejected",
    } satisfies ToolCallResult;
    const toolScheduler = {
      executeBatch: vi
        .fn<ToolSchedulerInstance["executeBatch"]>()
        .mockResolvedValue([rejectedResult]),
    } as unknown as ToolSchedulerInstance;
    const lifecycle = new Lifecycle({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"file_path":"src/app.ts"}',
                  id: "call_edit",
                  index: 0,
                  name: "edit",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "I could not edit the file.", finishReason: "stop" }],
        ],
        requests,
      ),
      toolScheduler,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        sessionId: "session_test",
        messages: [{ role: "user", content: "Edit src/app.ts" }],
      }),
    );

    expect(requests[1]?.messages[2]).toEqual({
      role: "tool",
      content:
        '{"status":"rejected","error":{"type":"PermissionRejectedError","message":"Tool rejected by user: edit"}}',
      tool_call_id: "call_edit",
    });
    expect(result).toMatchObject({
      finalResponse: "I could not edit the file.",
      finishReason: "stop",
      success: true,
    });
  });

  it("uses generated tool call ids consistently in execution, messages, and result", async () => {
    const requests: ProviderRequest[] = [];
    const executeBatch = vi
      .fn<ToolSchedulerInstance["executeBatch"]>()
      .mockResolvedValue([
        {
          callId: "generated_call",
          output: "generated result",
          status: "success",
        },
      ]);
    const lifecycle = new Lifecycle({
      generateToolCallId: (): string => "generated_call",
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"value":1}',
                  id: "",
                  index: 0,
                  name: "compute",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "Done.", finishReason: "stop" }],
        ],
        requests,
      ),
      toolScheduler: {
        executeBatch,
      } as unknown as ToolSchedulerInstance,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        sessionId: "session_test",
        messages: [{ role: "user", content: "Compute" }],
      }),
    );

    expect(executeBatch).toHaveBeenCalledWith({
      calls: [
        expect.objectContaining({
          callId: "generated_call",
          toolName: "compute",
        }),
      ],
    });
    expect(requests[1]?.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "generated_call",
          function: { name: "compute" },
          type: "function",
        },
      ],
    });
    expect(result).toMatchObject({
      toolCalls: [{ id: "generated_call", name: "compute" }],
    });
  });

  it("turns scheduler batch rejections into tool results and finalizes ToolPart state", async () => {
    const requests: ProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const user = await messageManager.createMessage({
      sessionId: "session_test",
      role: "user",
      agent: "default",
    });
    const lifecycle = new Lifecycle({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "Recovered.", finishReason: "stop" }],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi
          .fn<ToolSchedulerInstance["executeBatch"]>()
          .mockRejectedValue(new Error("batch exploded")),
      } as unknown as ToolSchedulerInstance,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        sessionId: "session_test",
        agent: "default",
        parentMessageId: user.id,
        messages: [{ role: "user", content: "Read README" }],
      }),
    );

    expect(requests[1]?.messages[2]).toEqual({
      role: "tool",
      content:
        '{"status":"error","error":{"type":"ExecutionError","message":"Tool scheduler failed: batch exploded"}}',
      tool_call_id: "call_read",
    });
    await expect(
      messageManager.listBySession("session_test"),
    ).resolves.toMatchObject([
      { info: { id: "message_1", role: "user" } },
      {
        info: { id: "message_2", finish: "tool_calls", role: "assistant" },
        parts: [
          {
            callId: "call_read",
            state: {
              error:
                '{"status":"error","error":{"type":"ExecutionError","message":"Tool scheduler failed: batch exploded"}}',
              input: { path: "README.md" },
              status: "error",
            },
            type: "tool",
          },
        ],
      },
      {
        info: { id: "message_3", finish: "stop", role: "assistant" },
        parts: [{ text: "Recovered.", type: "text" }],
      },
    ]);
    expect(result).toMatchObject({
      finalResponse: "Recovered.",
      finishReason: "stop",
      success: true,
    });
  });

  it("fails conservatively when the model finishes with tool calls but none parse", async () => {
    const requests: ProviderRequest[] = [];
    const executeBatch = vi.fn<ToolSchedulerInstance["executeBatch"]>();
    const lifecycle = new Lifecycle({
      llmClient: createSequentialFakeLLMClient(
        [[{ finishReason: "tool_calls" }]],
        requests,
      ),
      toolScheduler: {
        executeBatch,
      } as unknown as ToolSchedulerInstance,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        sessionId: "session_test",
        messages: [{ role: "user", content: "Use a tool" }],
      }),
    );

    expect(executeBatch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      finalResponse: "Model requested tool calls but none were parsed",
      finishReason: "error",
      success: false,
    });
  });

  it("persists tool call parts and tool results when a MessageManager is provided", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const user = await messageManager.createMessage({
      sessionId: "session_test",
      role: "user",
      agent: "default",
    });
    await messageManager.appendPart(user.id, {
      type: "text",
      text: "Check weather",
    });
    const lifecycle = new Lifecycle({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"location":"NYC"}',
                  id: "call_weather",
                  index: 0,
                  name: "get_weather",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "It is sunny.", finishReason: "stop" }],
        ],
        [],
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi
          .fn<ToolSchedulerInstance["executeBatch"]>()
          .mockResolvedValue([
            {
              callId: "call_weather",
              output: "weather: sunny",
              status: "success",
            },
          ]),
      } as unknown as ToolSchedulerInstance,
    });

    await consumeLifecycle(
      lifecycle.run({
        sessionId: "session_test",
        agent: "default",
        parentMessageId: user.id,
        messages: await messageManager.toModelMessages("session_test"),
      }),
    );

    await expect(
      messageManager.listBySession("session_test"),
    ).resolves.toMatchObject([
      { info: { id: "message_1", role: "user" } },
      {
        info: {
          id: "message_2",
          finish: "tool_calls",
          parentId: "message_1",
          role: "assistant",
        },
        parts: [
          {
            callId: "call_weather",
            state: {
              input: { location: "NYC" },
              output: "weather: sunny",
              status: "completed",
            },
            tool: "get_weather",
            type: "tool",
          },
        ],
      },
      {
        info: {
          id: "message_3",
          finish: "stop",
          parentId: "message_2",
          role: "assistant",
        },
        parts: [{ id: "part_3", text: "It is sunny.", type: "text" }],
      },
    ]);
  });

  it("marks the assistant message as error when streaming fails", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const user = await messageManager.createMessage({
      sessionId: "session_test",
      role: "user",
      agent: "default",
    });
    const lifecycle = new Lifecycle({
      llmClient: createRejectingLLMClient(new Error("stream failed")),
      messageManager,
    });
    const loop = lifecycle.run({
      sessionId: "session_test",
      agent: "default",
      parentMessageId: user.id,
      messages: [{ role: "user", content: "Say hello" }],
    });

    await expect(consumeLifecycle(loop)).rejects.toThrow("stream failed");

    await expect(
      messageManager.listBySession("session_test"),
    ).resolves.toMatchObject([
      { info: { id: "message_1", role: "user" } },
      {
        info: {
          id: "message_2",
          role: "assistant",
          parentId: "message_1",
          finish: "error",
          error: { name: "Unknown", message: "stream failed" },
        },
      },
    ]);
  });

  it("returns an error result when provider abort yields partial completion", async () => {
    const controller = new AbortController();
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const user = await messageManager.createMessage({
      sessionId: "session_test",
      role: "user",
      agent: "default",
    });
    const lifecycle = new Lifecycle({
      llmClient: createAbortingLLMClient({
        abort: () => {
          controller.abort();
        },
        error: new Error("aborted"),
      }),
      messageManager,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        sessionId: "session_test",
        agent: "default",
        parentMessageId: user.id,
        messages: [{ role: "user", content: "Say hello" }],
        signal: controller.signal,
      }),
    );

    expect(result).toMatchObject({
      finalResponse: "Partial",
      finishReason: "error",
      success: false,
    });
    await expect(
      messageManager.listBySession("session_test"),
    ).resolves.toMatchObject([
      { info: { id: "message_1", role: "user" } },
      {
        info: {
          id: "message_2",
          role: "assistant",
          parentId: "message_1",
          finish: "error",
          error: { name: "Unknown", message: "Lifecycle aborted" },
        },
        parts: [{ id: "part_1", text: "Partial", type: "text" }],
      },
    ]);
  });
});

async function consumeLifecycle(
  loop: AsyncGenerator<unknown, unknown, void>,
): Promise<unknown> {
  let next = await loop.next();
  while (!next.done) {
    next = await loop.next();
  }
  return next.value;
}

async function consumeLifecycleEvents(
  loop: AsyncGenerator<LifecycleEvent, LifecycleResult, void>,
): Promise<{
  readonly events: string[];
  readonly result: LifecycleResult;
}> {
  const events: string[] = [];
  let next = await loop.next();
  while (!next.done) {
    events.push(next.value.type);
    next = await loop.next();
  }

  return { events, result: next.value };
}

function createDeterministicIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;

  return {
    messageId(): string {
      const id = `message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}
