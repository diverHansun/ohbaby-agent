import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { InterfaceProviderStreamEvent } from "./types.js";

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

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function drainRequest(request: IncomingMessage): Promise<void> {
  for await (const _ of request) {
    // Drain the request body before returning the fake streaming response.
  }
}

describe("openai-compatible provider", () => {
  it("should build streaming request parameters for OpenAI-compatible APIs", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai",
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
    const events: InterfaceProviderStreamEvent[] = [];

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
      id: "zhipu",
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
    const events: InterfaceProviderStreamEvent[] = [];

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
      id: "openai",
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
    const events: InterfaceProviderStreamEvent[] = [];

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

  it("should stream chunked local SSE responses with native fetch on Node", async () => {
    const server = createServer((request, response) => {
      void drainRequest(request)
        .then(() => {
          response.writeHead(200, {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
          });
          writeSse(response, {
            choices: [
              {
                delta: { content: "chunked ok" },
                finish_reason: null,
                index: 0,
              },
            ],
            created: 0,
            id: "chatcmpl-test",
            model: "fake-model",
            object: "chat.completion.chunk",
          });
          writeSse(response, {
            choices: [
              {
                delta: {},
                finish_reason: "stop",
                index: 0,
              },
            ],
            created: 0,
            id: "chatcmpl-test",
            model: "fake-model",
            object: "chat.completion.chunk",
          });
          writeSse(response, {
            choices: [],
            created: 0,
            id: "chatcmpl-test",
            model: "fake-model",
            object: "chat.completion.chunk",
            usage: {
              completion_tokens: 2,
              prompt_tokens: 1,
              total_tokens: 3,
            },
          });
          response.end("data: [DONE]\n\n");
        })
        .catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : undefined);
        });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const address = server.address() as AddressInfo;
      const provider = createOpenAICompatibleProvider({
        id: "openai",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      });
      const stream = await provider.streamChatCompletion({
        model: "fake-model",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0,
        maxTokens: 128,
      });
      const events: InterfaceProviderStreamEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toEqual([
        { textDelta: "chunked ok" },
        {
          finishReason: "stop",
          rawFinishReason: "stop",
          tokenUsage: {
            completion_tokens: 2,
            prompt_tokens: 1,
            total_tokens: 3,
          },
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
