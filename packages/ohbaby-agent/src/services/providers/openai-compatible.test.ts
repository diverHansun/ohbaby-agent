import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { ProviderStreamEvent } from "./types.js";

function createChunk(
  chunk: Omit<ChatCompletionChunk, "id" | "created" | "model" | "object">,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    created: 0,
    model: "gpt-4",
    object: "chat.completion.chunk",
    ...chunk,
  };
}

function createChunkStream(
  chunks: readonly ChatCompletionChunk[],
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  return (async function* (): AsyncGenerator<
    ChatCompletionChunk,
    void,
    unknown
  > {
    for (const chunk of chunks) {
      yield await Promise.resolve(chunk);
    }
  })();
}

describe("openai-compatible provider", () => {
  it("should build streaming request parameters for OpenAI-compatible APIs", async () => {
    const provider = createOpenAICompatibleProvider({
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });
    const create = vi
      .spyOn(provider.client.chat.completions, "create")
      .mockResolvedValue(
        createChunkStream([
          createChunk({
            choices: [
              {
                delta: { content: "ok" },
                finish_reason: "stop",
                index: 0,
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          }),
        ]) as unknown as Awaited<
          ReturnType<typeof provider.client.chat.completions.create>
        >,
      );

    const controller = new AbortController();
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "test_tool",
          description: "Test tool",
          parameters: {
            type: "object" as const,
            properties: {},
          },
        },
      },
    ];
    const stream = await provider.streamChatCompletion({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      maxTokens: 128,
      tools,
      signal: controller.signal,
    });
    const events: ProviderStreamEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    expect(create).toHaveBeenCalledWith(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.7,
        max_tokens: 128,
        stream: true,
        stream_options: { include_usage: true },
        tools,
      },
      { signal: controller.signal },
    );
    expect(events).toEqual([
      {
        textDelta: "ok",
        finishReason: "stop",
        rawFinishReason: "stop",
        tokenUsage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      },
    ]);
  });

  it("should normalize tool call deltas and legacy finish reasons", async () => {
    const provider = createOpenAICompatibleProvider({
      provider: "zhipu",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
    });
    vi.spyOn(provider.client.chat.completions, "create").mockResolvedValue(
      createChunkStream([
        createChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_123",
                    function: {
                      name: "get_weather",
                      arguments: '{"location":"',
                    },
                  },
                ],
              },
              finish_reason: null,
              index: 0,
            },
          ],
        }),
        createChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: 'NYC"}',
                    },
                  },
                ],
              },
              finish_reason: "function_call",
              index: 0,
            },
          ],
        }),
      ]) as unknown as Awaited<
        ReturnType<typeof provider.client.chat.completions.create>
      >,
    );

    const stream = await provider.streamChatCompletion({
      model: "glm-4-plus",
      messages: [{ role: "user", content: "weather" }],
      temperature: 0.2,
      maxTokens: 64,
    });
    const events: ProviderStreamEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        toolCallDeltas: [
          {
            index: 0,
            id: "call_123",
            name: "get_weather",
            argumentsDelta: '{"location":"',
          },
        ],
      },
      {
        toolCallDeltas: [
          {
            index: 0,
            argumentsDelta: 'NYC"}',
          },
        ],
        finishReason: "tool_calls",
        rawFinishReason: "function_call",
      },
    ]);
  });

  it("should yield token usage from the final usage-only chunk", async () => {
    const provider = createOpenAICompatibleProvider({
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });
    vi.spyOn(provider.client.chat.completions, "create").mockResolvedValue(
      createChunkStream([
        createChunk({
          choices: [
            {
              delta: { content: "ok" },
              finish_reason: "stop",
              index: 0,
            },
          ],
        }),
        createChunk({
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        }),
      ]) as unknown as Awaited<
        ReturnType<typeof provider.client.chat.completions.create>
      >,
    );

    const stream = await provider.streamChatCompletion({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      maxTokens: 128,
    });
    const events: ProviderStreamEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        textDelta: "ok",
        finishReason: "stop",
        rawFinishReason: "stop",
        tokenUsage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      },
    ]);
  });
});
