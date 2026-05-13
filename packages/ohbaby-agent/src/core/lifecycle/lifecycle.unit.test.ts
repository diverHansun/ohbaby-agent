import { describe, expect, it } from "vitest";
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
