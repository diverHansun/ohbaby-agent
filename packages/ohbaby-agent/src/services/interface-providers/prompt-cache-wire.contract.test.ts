import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import { describe, expect, it, vi } from "vitest";
import { resolvePromptCacheRequest } from "../../core/llm-client/prompt-cache.js";
import type { PromptCachePolicy } from "../../config/index.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type {
  InterfaceProviderPromptCache,
  InterfaceProviderStreamEvent,
} from "./types.js";

function emptyStream<T>(): AsyncGenerator<T, void, unknown> {
  return (async function* (): AsyncGenerator<T, void, unknown> {
    await Promise.resolve();
    yield* [] as T[];
  })();
}

function observeOnly(): InterfaceProviderPromptCache {
  return { strategy: "observe-only", reason: "contract fixture" };
}

function wirePromptCache(input: {
  readonly baseUrl: string;
  readonly interfaceProvider: "openai-compatible" | "anthropic";
  readonly messages: readonly ChatCompletionMessageParam[];
  readonly policy?: PromptCachePolicy;
  readonly provider: string;
}): InterfaceProviderPromptCache {
  return resolvePromptCacheRequest({
    ...input,
    policy: input.policy ?? "auto",
    purpose: "agent-step",
    sessionId: "contract-session",
  });
}

function cacheExtensionKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.keys(value)
    .filter((key) => key.includes("cache"))
    .sort();
}

describe("prompt-cache wire contract", () => {
  it("sends an opaque key and usage request only for keyed OpenAI strategy", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });
    const create = vi
      .spyOn(provider.client.chat.completions, "create")
      .mockResolvedValue(
        emptyStream<ChatCompletionChunk>() as unknown as Awaited<
          ReturnType<typeof provider.client.chat.completions.create>
        >,
      );

    await provider.streamChatCompletion({
      maxTokens: 128,
      messages: [{ role: "user", content: "Hello" }],
      model: "gpt-5.6",
      promptCache: {
        key: "ob:v1:opaque-key",
        reason: "contract fixture",
        strategy: "openai-keyed-implicit",
      },
      temperature: 0,
    });

    const params = create.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      prompt_cache_key: "ob:v1:opaque-key",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(cacheExtensionKeys(params)).toEqual(["prompt_cache_key"]);
  });

  it("disabled omits OpenAI controls while cache usage observation stays active", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });
    const create = vi
      .spyOn(provider.client.chat.completions, "create")
      .mockResolvedValue(
        (async function* (): AsyncGenerator<
          ChatCompletionChunk,
          void,
          unknown
        > {
          await Promise.resolve();
          yield {
            choices: [],
            created: 0,
            id: "chatcmpl-cache-usage",
            model: "gpt-5.6",
            object: "chat.completion.chunk",
            usage: {
              completion_tokens: 2,
              prompt_tokens: 10,
              prompt_tokens_details: { cached_tokens: 8 },
              total_tokens: 12,
            },
          };
        })() as unknown as Awaited<
          ReturnType<typeof provider.client.chat.completions.create>
        >,
      );
    const result = await provider.streamChatCompletion({
      maxTokens: 128,
      messages: [{ role: "user", content: "Hello" }],
      model: "gpt-5.6",
      promptCache: wirePromptCache({
        baseUrl: "https://api.openai.com/v1",
        interfaceProvider: "openai-compatible",
        messages: [{ role: "user", content: "Hello" }],
        policy: "disabled",
        provider: "openai",
      }),
      temperature: 0,
    });
    const events: InterfaceProviderStreamEvent[] = [];
    for await (const event of result) {
      events.push(event);
    }

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("prompt_cache_key");
    expect(cacheExtensionKeys(create.mock.calls[0]?.[0])).toEqual([]);
    expect(events.at(-1)?.tokenUsage).toEqual({
      inputBreakdown: {
        cacheRead: 8,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 2,
      },
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  });

  it.each([
    ["DeepSeek", "https://api.deepseek.com/v1"],
    ["Zhipu", "https://open.bigmodel.cn/api/paas/v4"],
    ["ZenMux", "https://zenmux.ai/api/v1"],
    ["unknown gateway", "https://gateway.example.test/v1"],
  ])("omits prompt_cache_key for %s auto", async (providerName, baseUrl) => {
    const provider = createOpenAICompatibleProvider({
      id: providerName,
      apiKey: "test-key",
      baseUrl,
    });
    const create = vi
      .spyOn(provider.client.chat.completions, "create")
      .mockResolvedValue(
        emptyStream<ChatCompletionChunk>() as unknown as Awaited<
          ReturnType<typeof provider.client.chat.completions.create>
        >,
      );

    await provider.streamChatCompletion({
      maxTokens: 128,
      messages: [{ role: "user", content: "Hello" }],
      model: "model",
      promptCache: wirePromptCache({
        baseUrl,
        interfaceProvider: "openai-compatible",
        messages: [{ role: "user", content: "Hello" }],
        policy: "auto",
        provider: providerName,
      }),
      temperature: 0,
    });

    const params = create.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("prompt_cache_key");
    expect(cacheExtensionKeys(params)).toEqual([]);
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("sends official Anthropic top-level automatic cache control", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockReturnValue(emptyStream<RawMessageStreamEvent>());

    await provider.streamChatCompletion({
      maxTokens: 128,
      messages: [
        { role: "system", content: "Stable system" },
        { role: "user", content: "Hello" },
      ],
      model: "claude-sonnet-4-6",
      promptCache: wirePromptCache({
        baseUrl: "https://api.anthropic.com",
        interfaceProvider: "anthropic",
        messages: [
          { role: "system", content: "Stable system" },
          { role: "user", content: "Hello" },
        ],
        policy: "auto",
        provider: "anthropic",
      }),
      temperature: 0,
    });

    const params = stream.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      cache_control: { type: "ephemeral" },
      system: [
        {
          cache_control: { type: "ephemeral" },
          text: "Stable system",
          type: "text",
        },
      ],
    });
    expect(JSON.stringify(params.messages)).not.toContain("cache_control");
  });

  it("keeps Anthropic tools, stable system blocks, and prior messages as a structural prefix across tool steps", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockReturnValue(emptyStream<RawMessageStreamEvent>());
    const tools = [
      {
        function: {
          name: "read_fixture",
          parameters: { properties: {}, type: "object" },
        },
        type: "function" as const,
      },
      {
        function: {
          name: "write_fixture",
          parameters: { properties: {}, type: "object" },
        },
        type: "function" as const,
      },
    ];
    const firstMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: "Stable system" },
      { role: "user", content: "Read the fixture" },
    ];
    const secondMessages: ChatCompletionMessageParam[] = [
      ...firstMessages,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            function: { arguments: "{}", name: "read_fixture" },
            id: "call_read",
            type: "function",
          },
        ],
      },
      { role: "tool", content: "fixture", tool_call_id: "call_read" },
    ];
    for (const messages of [firstMessages, secondMessages]) {
      await provider.streamChatCompletion({
        maxTokens: 128,
        messages,
        model: "claude-sonnet-4-6",
        promptCache: wirePromptCache({
          baseUrl: "https://api.anthropic.com",
          interfaceProvider: "anthropic",
          messages,
          provider: "anthropic",
        }),
        temperature: 0,
        tools,
      });
    }

    const first = stream.mock.calls[0][0];
    const second = stream.mock.calls[1][0];
    expect(second.tools).toEqual(first.tools);
    expect(second.system).toEqual(first.system);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
  });

  it("keeps the official stable-system anchor beyond twenty tool-use/result blocks", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockReturnValue(emptyStream<RawMessageStreamEvent>());
    const toolCalls = Array.from({ length: 21 }, (_, index) => ({
      function: {
        arguments: JSON.stringify({ index }),
        name: "read_fixture",
      },
      id: `call_${String(index)}`,
      type: "function" as const,
    }));
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "Stable system" },
      { role: "assistant", content: null, tool_calls: toolCalls },
      ...toolCalls.map((toolCall) => ({
        role: "tool" as const,
        content: `result-${toolCall.id}`,
        tool_call_id: toolCall.id,
      })),
    ];

    await provider.streamChatCompletion({
      maxTokens: 128,
      messages,
      model: "claude-sonnet-4-6",
      promptCache: wirePromptCache({
        baseUrl: "https://api.anthropic.com",
        interfaceProvider: "anthropic",
        messages,
        policy: "auto",
        provider: "anthropic",
      }),
      temperature: 0,
      tools: [
        {
          function: {
            name: "read_fixture",
            parameters: { properties: {}, type: "object" },
          },
          type: "function",
        },
        {
          function: {
            name: "write_fixture",
            parameters: { properties: {}, type: "object" },
          },
          type: "function",
        },
      ],
    });

    const params = stream.mock.calls[0][0];
    expect(params.messages).toHaveLength(2);
    expect(params.tools?.map((tool) => tool.name)).toEqual([
      "read_fixture",
      "write_fixture",
    ]);
    expect(
      params.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "tool_use")
          : [],
      ),
    ).toHaveLength(21);
    expect(
      params.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "tool_result")
          : [],
      ),
    ).toHaveLength(21);
    expect(params.system).toEqual([
      {
        cache_control: { type: "ephemeral" },
        text: "Stable system",
        type: "text",
      },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
  });

  it("disabled Anthropic omits controls while start/delta cache usage stays active", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const stream = vi.spyOn(provider.client.messages, "stream").mockReturnValue(
      (async function* (): AsyncGenerator<
        RawMessageStreamEvent,
        void,
        unknown
      > {
        await Promise.resolve();
        yield {
          type: "message_start",
          message: {
            usage: {
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 60,
              input_tokens: 10,
              output_tokens: 0,
            },
          },
        } as unknown as RawMessageStreamEvent;
        yield {
          type: "message_delta",
          delta: {
            container: null,
            stop_reason: "end_turn",
            stop_details: null,
            stop_sequence: null,
          },
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 5,
            server_tool_use: null,
          },
        };
      })(),
    );
    const messages = [{ role: "user" as const, content: "Hello" }];
    const result = await provider.streamChatCompletion({
      maxTokens: 128,
      messages,
      model: "claude-sonnet-4-6",
      promptCache: wirePromptCache({
        baseUrl: "https://api.anthropic.com",
        interfaceProvider: "anthropic",
        messages,
        policy: "disabled",
        provider: "anthropic",
      }),
      temperature: 0,
    });
    const events: InterfaceProviderStreamEvent[] = [];
    for await (const event of result) {
      events.push(event);
    }

    const params = stream.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("cache_control");
    expect(JSON.stringify(params.messages)).not.toContain("cache_control");
    expect(events.at(-1)?.tokenUsage).toEqual({
      inputBreakdown: {
        cacheRead: 60,
        cacheWrite: 30,
        observed: { cacheRead: true, cacheWrite: true },
        uncached: 10,
      },
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
    });
  });

  it("marks only the last eligible ZenMux Anthropic block without mutating domain messages", async () => {
    const provider = createAnthropicProvider({
      id: "zenmux",
      apiKey: "test-key",
      baseUrl: "https://zenmux.ai/api/anthropic/v1",
    });
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockReturnValue(emptyStream<RawMessageStreamEvent>());
    const messages = [
      { role: "system" as const, content: "Stable system" },
      { role: "user" as const, content: "Earlier" },
      { role: "assistant" as const, content: "Answer" },
      { role: "user" as const, content: "Latest" },
    ];
    const before = structuredClone(messages);

    await provider.streamChatCompletion({
      maxTokens: 128,
      messages,
      model: "anthropic/claude-sonnet-4-6",
      promptCache: wirePromptCache({
        baseUrl: "https://zenmux.ai/api/anthropic/v1",
        interfaceProvider: "anthropic",
        messages,
        policy: "auto",
        provider: "zenmux",
      }),
      temperature: 0,
    });

    const params = stream.mock.calls[0]?.[0];
    expect(messages).toEqual(before);
    expect(params).not.toHaveProperty("cache_control");
    expect(params.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Latest",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(
      JSON.stringify(params.messages).match(/cache_control/gu),
    ).toHaveLength(1);
  });

  it("fails fast if a caller bypasses resolution with explicit caching and no eligible block", () => {
    const provider = createAnthropicProvider({
      id: "custom",
      apiKey: "test-key",
      baseUrl: "https://gateway.example.test/anthropic",
    });
    const stream = vi.spyOn(provider.client.messages, "stream");

    expect(() =>
      provider.streamChatCompletion({
        maxTokens: 128,
        messages: [],
        model: "claude-compatible",
        promptCache: {
          reason: "bypassed resolver fixture",
          strategy: "anthropic-explicit-last-block",
        },
        temperature: 0,
      }),
    ).toThrow(/requires an eligible content block/u);
    expect(stream).not.toHaveBeenCalled();
  });

  it("omits every cache control for disabled and DeepSeek Anthropic requests", async () => {
    const provider = createAnthropicProvider({
      id: "deepseek",
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/anthropic",
    });
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockReturnValue(emptyStream<RawMessageStreamEvent>());

    for (const promptCache of [
      observeOnly(),
      wirePromptCache({
        baseUrl: "https://api.deepseek.com/anthropic",
        interfaceProvider: "anthropic",
        messages: [{ role: "user", content: "Hello" }],
        policy: "auto",
        provider: "deepseek",
      }),
    ]) {
      await provider.streamChatCompletion({
        maxTokens: 128,
        messages: [{ role: "user", content: "Hello" }],
        model: "deepseek-chat",
        promptCache,
        temperature: 0,
      });
    }

    for (const [params] of stream.mock.calls) {
      expect(params).not.toHaveProperty("cache_control");
      expect(JSON.stringify(params.messages)).not.toContain("cache_control");
    }
  });
});
