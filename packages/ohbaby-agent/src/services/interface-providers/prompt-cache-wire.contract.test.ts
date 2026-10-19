import type {
  MessageCreateParams,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import { describe, expect, it, vi } from "vitest";
import { resolvePromptCacheRequest } from "../../core/llm-client/prompt-cache.js";
import type { PromptCachePolicy } from "../../config/index.js";
import { PRIMARY_BASE_PROMPT } from "../../core/system-prompt/prompts/primary/base.js";
import { computeBudgetReport } from "../../goals/budget.js";
import { renderGoalTurnPrompt } from "../../goals/injection.js";
import { createGoalTools } from "../../goals/tools.js";
import type { GoalSnapshot } from "../../goals/types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { createOpenAIResponsesProvider } from "./openai-responses.js";
import type {
  InterfaceProviderPromptCache,
  LLMRequestPurpose,
  InterfaceProviderStreamEvent,
  ModelMessage,
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
  readonly interfaceProvider:
    | "openai-compatible"
    | "openai-responses"
    | "anthropic";
  readonly messages: readonly ModelMessage[];
  readonly policy?: PromptCachePolicy;
  readonly provider: string;
  readonly purpose?: LLMRequestPurpose;
}): InterfaceProviderPromptCache {
  return resolvePromptCacheRequest({
    ...input,
    policy: input.policy ?? "auto",
    purpose: input.purpose ?? "agent-step",
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

function customToolNames(tools: MessageCreateParams["tools"]): string[] {
  return (tools ?? []).map((tool) => {
    if (!("name" in tool) || !("input_schema" in tool)) {
      throw new Error("Expected an Anthropic custom tool.");
    }
    return tool.name;
  });
}

describe("prompt-cache wire contract", () => {
  it("appends changing goal reminders without rewriting any provider's cached prefix", async () => {
    const chat = createOpenAICompatibleProvider({
      id: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });
    const chatCreate = vi
      .spyOn(chat.client.chat.completions, "create")
      .mockResolvedValue(
        emptyStream<ChatCompletionChunk>() as unknown as Awaited<
          ReturnType<typeof chat.client.chat.completions.create>
        >,
      );
    const responses = createOpenAIResponsesProvider({
      id: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });
    const responsesCreate = vi
      .spyOn(responses.client.responses, "create")
      .mockResolvedValue(
        emptyStream() as unknown as Awaited<
          ReturnType<typeof responses.client.responses.create>
        >,
      );
    const anthropic = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const anthropicStream = vi
      .spyOn(anthropic.client.messages, "stream")
      .mockReturnValue(emptyStream<RawMessageStreamEvent>());
    const firstGoal: GoalSnapshot = {
      goalId: "cache-goal",
      objective: "Fix checkout validation without changing the payment API.",
      completionCriterion: "Checkout integration tests pass.",
      status: "active",
      turnsUsed: 1,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
      budget: computeBudgetReport(
        { turnsUsed: 1, tokensUsed: 0, wallClockMs: 0 },
        {},
      ),
    };
    const nextUsage = { turnsUsed: 2, tokensUsed: 1200, wallClockMs: 45_000 };
    const budgetLimits = { turnBudget: 4, wallClockBudgetMs: 60_000 };
    const nextGoal: GoalSnapshot = {
      ...firstGoal,
      ...nextUsage,
      budgetLimits,
      budget: computeBudgetReport(nextUsage, budgetLimits),
    };
    const firstReminder = renderGoalTurnPrompt(firstGoal, {
      isFirstTurn: true,
    });
    const nextReminder = renderGoalTurnPrompt(nextGoal, { isFirstTurn: false });
    expect(nextReminder).not.toBe(firstReminder);
    const firstMessages: ModelMessage[] = [
      { role: "system", content: PRIMARY_BASE_PROMPT },
      { role: "user", content: firstReminder },
    ];
    const nextMessages: ModelMessage[] = [
      ...firstMessages,
      {
        role: "assistant",
        content: "Validation fixed; integration tests remain.",
      },
      { role: "user", content: nextReminder },
    ];
    const tools = createGoalTools({
      createGoal: vi.fn(),
      updateGoalFromModel: vi.fn(),
      getSnapshot: vi.fn(),
      setBudget: vi.fn(),
    }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parametersJsonSchema,
    }));
    const before = structuredClone({ firstMessages, nextMessages, tools });

    for (const messages of [firstMessages, nextMessages]) {
      for (const [kind, provider] of [
        ["openai-compatible", chat],
        ["openai-responses", responses],
        ["anthropic", anthropic],
      ] as const) {
        const promptCache = wirePromptCache({
          baseUrl:
            kind === "anthropic"
              ? "https://api.anthropic.com"
              : "https://api.openai.com/v1",
          interfaceProvider: kind,
          messages,
          provider: provider.id,
        });
        if (kind === "openai-responses")
          expect(promptCache.strategy).toBe("observe-only");
        await provider.streamResponse({
          purpose: "agent-step",
          maxTokens: 128,
          model: kind === "anthropic" ? "claude-fixture" : "gpt-fixture",
          messages,
          tools,
          promptCache,
        });
      }
    }

    const firstChat = chatCreate.mock.calls[0][0];
    const nextChat = chatCreate.mock.calls[1][0];
    expect(nextChat.messages).toEqual([
      ...firstChat.messages,
      ...nextMessages.slice(firstMessages.length),
    ]);
    expect(firstChat.messages).toEqual(firstMessages);
    expect(nextChat.tools).toEqual(firstChat.tools);
    const chatKey = (firstChat as unknown as Record<string, unknown>)
      .prompt_cache_key;
    expect(chatKey).toEqual(expect.any(String));
    expect(nextChat).toHaveProperty("prompt_cache_key", chatKey);
    for (const request of [firstChat, nextChat])
      expect(cacheExtensionKeys(request)).toEqual(["prompt_cache_key"]);

    const firstResponses = responsesCreate.mock.calls[0][0];
    const nextResponses = responsesCreate.mock.calls[1][0];
    expect(firstResponses.instructions).toBe(PRIMARY_BASE_PROMPT);
    expect(nextResponses.instructions).toBe(firstResponses.instructions);
    expect(firstResponses.input).toEqual(firstMessages.slice(1));
    expect(nextResponses.input).toEqual(nextMessages.slice(1));
    expect(nextResponses.tools).toEqual(firstResponses.tools);
    for (const request of [firstResponses, nextResponses]) {
      expect(cacheExtensionKeys(request)).toEqual([]);
      expect(request).not.toHaveProperty("previous_response_id");
      expect(request.store).toBe(false);
    }

    const firstAnthropic = anthropicStream.mock.calls[0][0];
    const nextAnthropic = anthropicStream.mock.calls[1][0];
    expect(firstAnthropic.system).toEqual([
      {
        type: "text",
        text: PRIMARY_BASE_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(nextAnthropic.system).toEqual(firstAnthropic.system);
    expect(firstAnthropic.messages).toEqual(firstMessages.slice(1));
    expect(nextAnthropic.messages).toEqual(nextMessages.slice(1));
    expect(nextAnthropic.tools).toEqual(firstAnthropic.tools);
    for (const request of [firstAnthropic, nextAnthropic]) {
      expect(request.cache_control).toEqual({ type: "ephemeral" });
      expect(JSON.stringify(request.messages)).not.toContain("cache_control");
    }
    expect({ firstMessages, nextMessages, tools }).toEqual(before);
  });

  it("shares the scoped Chat key and unchanged history/tools with a summary", async () => {
    const baseUrl = "https://api.openai.com/v1";
    const provider = createOpenAICompatibleProvider({
      id: "openai",
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
    const history: ModelMessage[] = [
      { role: "system", content: "Stable system" },
      { role: "user", content: "Actual history" },
    ];
    for (const purpose of ["agent-step", "context-summary"] as const) {
      const messages: ModelMessage[] =
        purpose === "agent-step"
          ? history
          : [...history, { role: "user", content: "Summarize" }];
      await provider.streamResponse({
        purpose,
        maxTokens: 16384,
        model: "gpt-5.6",
        messages,
        tools: [
          { name: "lookup", inputSchema: { type: "object", properties: {} } },
        ],
        promptCache: wirePromptCache({
          baseUrl,
          interfaceProvider: "openai-compatible",
          messages,
          provider: "openai",
          purpose,
        }),
      });
    }
    const normal = create.mock.calls[0][0];
    const summary = create.mock.calls[1][0];
    expect(summary.prompt_cache_key).toEqual(expect.any(String));
    expect(summary.prompt_cache_key).toBe(normal.prompt_cache_key);
    expect(summary.messages).toEqual([
      ...normal.messages,
      { role: "user", content: "Summarize" },
    ]);
    expect(summary.tools).toEqual(normal.tools);
  });

  it.each([
    ["anthropic", "https://api.anthropic.com", 2],
    ["zenmux", "https://zenmux.ai/api/anthropic/v1", 1],
  ] as const)(
    "%s summary marks real grouped tool history and preserves native blocks",
    async (id, baseUrl, markerCount) => {
      const provider = createAnthropicProvider({
        id,
        apiKey: "test-key",
        baseUrl,
      });
      const stream = vi
        .spyOn(provider.client.messages, "stream")
        .mockReturnValue(emptyStream<RawMessageStreamEvent>());
      const nativeBlocks = [
        {
          type: "thinking" as const,
          thinking: "Native reasoning",
          signature: "opaque-signature",
        },
        { type: "text" as const, text: "Native answer" },
        {
          type: "tool_use" as const,
          id: "call-a",
          name: "lookup",
          input: { query: "a" },
        },
        {
          type: "tool_use" as const,
          id: "call-b",
          name: "lookup",
          input: { query: "b" },
        },
      ];
      const history: ModelMessage[] = [
        { role: "system", content: "Stable system" },
        { role: "user", content: "Read both" },
        {
          role: "assistant",
          content: "Native answer",
          toolCalls: [
            {
              callId: "call-a",
              name: "lookup",
              argumentsJson: '{"query":"a"}',
            },
            {
              callId: "call-b",
              name: "lookup",
              argumentsJson: '{"query":"b"}',
            },
          ],
          modelState: {
            version: 1,
            estimate: { tokens: 5, source: "output" },
            origin: {
              provider: id,
              model: "claude-fixture",
              protocol: "anthropic",
              endpoint: baseUrl,
            },
            output: { protocol: "anthropic", items: nativeBlocks },
          },
        },
        { role: "tool", callId: "call-a", content: "Result a" },
        { role: "tool", callId: "call-b", content: "Result b" },
      ];
      const before = structuredClone(history);
      for (const purpose of ["agent-step", "context-summary"] as const) {
        const messages: ModelMessage[] =
          purpose === "agent-step"
            ? history
            : [...history, { role: "user", content: "Summarize" }];
        await provider.streamResponse({
          purpose,
          maxTokens: 16384,
          model: "claude-fixture",
          messages,
          tools: [
            {
              name: "lookup",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ],
          promptCache: wirePromptCache({
            baseUrl,
            interfaceProvider: "anthropic",
            messages,
            provider: id,
            purpose,
          }),
        });
      }
      const normal = stream.mock.calls[0][0];
      const summary = stream.mock.calls[1][0];
      expect(summary).not.toHaveProperty("cache_control");
      expect(summary.system).toEqual(normal.system);
      expect(summary.tools).toEqual(normal.tools);
      expect(summary.messages).toEqual([
        { role: "user", content: "Read both" },
        { role: "assistant", content: nativeBlocks },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "Result a" },
            {
              type: "tool_result",
              tool_use_id: "call-b",
              content: "Result b",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        { role: "user", content: "Summarize" },
      ]);
      expect(JSON.stringify(summary).match(/cache_control/gu)).toHaveLength(
        markerCount,
      );
      expect(history).toEqual(before);
    },
  );

  it.each(["https://api.anthropic.com", "https://zenmux.ai/api/anthropic/v1"])(
    "marks history before a native thinking-only tail for %s summaries",
    async (baseUrl) => {
      const provider = createAnthropicProvider({
        id: "fixture",
        apiKey: "test-key",
        baseUrl,
      });
      const stream = vi
        .spyOn(provider.client.messages, "stream")
        .mockReturnValue(emptyStream<RawMessageStreamEvent>());
      const thinking = {
        type: "thinking" as const,
        thinking: "Still thinking",
        signature: "signed",
      };
      const messages: ModelMessage[] = [
        { role: "user", content: "Actual history" },
        {
          role: "assistant",
          content: "",
          modelState: {
            version: 1,
            estimate: { tokens: 5, source: "output" },
            origin: {
              provider: "fixture",
              model: "claude-fixture",
              protocol: "anthropic",
              endpoint: baseUrl,
            },
            output: { protocol: "anthropic", items: [thinking] },
          },
        },
        { role: "user", content: "Summarize" },
      ];
      await provider.streamResponse({
        purpose: "context-summary",
        maxTokens: 16384,
        model: "claude-fixture",
        messages,
        promptCache: wirePromptCache({
          baseUrl,
          interfaceProvider: "anthropic",
          messages,
          provider: "fixture",
          purpose: "context-summary",
        }),
      });
      expect(stream.mock.calls[0][0].messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Actual history",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        { role: "assistant", content: [thinking] },
        { role: "user", content: "Summarize" },
      ]);
    },
  );

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

    await provider.streamResponse({
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
    const result = await provider.streamResponse({
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

  it.each(
    (["auto", "enabled", "disabled"] as const).flatMap((policy) =>
      (["agent-step", "context-summary"] as const).map((purpose) => ({
        policy,
        purpose,
      })),
    ),
  )(
    "keeps Responses cache and continuation controls absent for $policy/$purpose",
    async ({ policy, purpose }) => {
      const provider = createOpenAIResponsesProvider({
        id: "openai",
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
      });
      const create = vi
        .spyOn(provider.client.responses, "create")
        .mockResolvedValue(
          emptyStream() as unknown as Awaited<
            ReturnType<typeof provider.client.responses.create>
          >,
        );

      const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
      if (purpose === "context-summary")
        messages.push({ role: "user", content: "Summarize" });
      await provider.streamResponse({
        purpose,
        maxTokens: 128,
        messages,
        model: "gpt-5.6",
        promptCache: wirePromptCache({
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-responses",
          messages,
          policy,
          purpose,
          provider: "openai",
        }),
        temperature: 0,
        tools: [
          {
            name: "lookup",
            inputSchema: {
              properties: { query: { type: "string" } },
              type: "object",
            },
          },
        ],
      });

      const params = create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(params).toEqual({
        input:
          purpose === "context-summary"
            ? [
                { role: "user", content: "Hello" },
                { role: "user", content: "Summarize" },
              ]
            : [{ role: "user", content: "Hello" }],
        max_output_tokens: 128,
        model: "gpt-5.6",
        store: false,
        stream: true,
        temperature: 0,
        tools: [
          {
            name: "lookup",
            parameters: {
              properties: { query: { type: "string" } },
              type: "object",
            },
            strict: false,
            type: "function",
          },
        ],
      });
      expect(params).not.toHaveProperty("previous_response_id");
    },
  );

  it("maps nested cacheControl to Chat cache_control without mutating caller messages", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "compatible-gateway",
      apiKey: "test-key",
      baseUrl: "https://gateway.example.test/v1",
    });
    const create = vi
      .spyOn(provider.client.chat.completions, "create")
      .mockResolvedValue(
        emptyStream<ChatCompletionChunk>() as unknown as Awaited<
          ReturnType<typeof provider.client.chat.completions.create>
        >,
      );
    const messages: ModelMessage[] = [
      {
        content: [
          {
            cacheControl: { ttl: "5m", type: "ephemeral" },
            text: "Keep this exact nested extension.",
            type: "text",
          },
        ],
        role: "user",
      },
    ];
    const before = structuredClone(messages);

    await provider.streamResponse({
      maxTokens: 128,
      messages,
      model: "compatible-model",
      promptCache: observeOnly(),
      temperature: 0,
    });

    const params = create.mock.calls[0]?.[0];
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Keep this exact nested extension.",
            cache_control: { ttl: "5m", type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(messages).toEqual(before);
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

    await provider.streamResponse({
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

  it("keeps official OpenAI system, tools, and prior messages as a structural prefix across tool steps", async () => {
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
    const tools = [
      {
        name: "read_fixture",
        inputSchema: { properties: {}, type: "object" },
      },
      {
        name: "write_fixture",
        inputSchema: { properties: {}, type: "object" },
      },
    ];
    const firstMessages: ModelMessage[] = [
      { role: "system", content: "Stable system" },
      { role: "user", content: "Read the fixture" },
    ];
    const secondMessages: ModelMessage[] = [
      ...firstMessages,
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            argumentsJson: "{}",
            name: "read_fixture",
            callId: "call_read",
          },
        ],
      },
      { role: "tool", content: "fixture", callId: "call_read" },
    ];
    for (const messages of [firstMessages, secondMessages]) {
      await provider.streamResponse({
        maxTokens: 128,
        messages,
        model: "gpt-5.6",
        promptCache: wirePromptCache({
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-compatible",
          messages,
          provider: "openai",
        }),
        temperature: 0,
        tools,
      });
    }

    const first = create.mock.calls[0][0];
    const second = create.mock.calls[1][0];
    const firstExtensions = first as unknown as Record<string, unknown>;
    const secondExtensions = second as unknown as Record<string, unknown>;
    expect(second.tools).toEqual(first.tools);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(firstExtensions.prompt_cache_key).toEqual(expect.any(String));
    expect(secondExtensions.prompt_cache_key).toBe(
      firstExtensions.prompt_cache_key,
    );
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

    await provider.streamResponse({
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
        name: "read_fixture",
        inputSchema: { properties: {}, type: "object" },
      },
      {
        name: "write_fixture",
        inputSchema: { properties: {}, type: "object" },
      },
    ];
    const firstMessages: ModelMessage[] = [
      { role: "system", content: "Stable system" },
      { role: "user", content: "Read the fixture" },
    ];
    const secondMessages: ModelMessage[] = [
      ...firstMessages,
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            argumentsJson: "{}",
            name: "read_fixture",
            callId: "call_read",
          },
        ],
      },
      { role: "tool", content: "fixture", callId: "call_read" },
    ];
    for (const messages of [firstMessages, secondMessages]) {
      await provider.streamResponse({
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
      argumentsJson: JSON.stringify({ index }),
      name: "read_fixture",
      callId: `call_${String(index)}`,
    }));
    const messages: ModelMessage[] = [
      { role: "system", content: "Stable system" },
      { role: "assistant", content: null, toolCalls },
      ...toolCalls.map((toolCall) => ({
        role: "tool" as const,
        content: `result-${toolCall.callId}`,
        callId: toolCall.callId,
      })),
    ];

    await provider.streamResponse({
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
          name: "read_fixture",
          inputSchema: { properties: {}, type: "object" },
        },
        {
          name: "write_fixture",
          inputSchema: { properties: {}, type: "object" },
        },
      ],
    });

    const params = stream.mock.calls[0][0];
    expect(params.messages).toHaveLength(2);
    expect(customToolNames(params.tools)).toEqual([
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
            output_tokens_details: null,
            server_tool_use: null,
          },
        };
      })(),
    );
    const messages = [{ role: "user" as const, content: "Hello" }];
    const result = await provider.streamResponse({
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

    await provider.streamResponse({
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
      provider.streamResponse({
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
      await provider.streamResponse({
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

it("preserves tool batches and separate reminder blocks on all wires without crossing the summary cache boundary", async () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "HOST" },
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { callId: "a", name: "lookup", argumentsJson: "{}" },
        { callId: "b", name: "lookup", argumentsJson: "{}" },
      ],
    },
    { role: "tool", callId: "a", content: "TOOL-A" },
    { role: "tool", callId: "b", content: "TOOL-B" },
    { role: "user", content: "STEER" },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>ENV</system-reminder>",
          source: "system-reminder",
        },
        {
          type: "text",
          text: "<system-reminder>MODE</system-reminder>",
          source: "system-reminder",
        },
      ],
    },
    { role: "user", content: "STEP-LIMIT" },
  ];
  const anthropic = createAnthropicProvider({
    id: "anthropic",
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.com",
  });
  const stream = vi
    .spyOn(anthropic.client.messages, "stream")
    .mockReturnValue(emptyStream<RawMessageStreamEvent>());
  const normal = {
    model: "claude",
    messages,
    maxTokens: 128,
    promptCache: {
      strategy: "anthropic-explicit-last-block" as const,
      reason: "test",
    },
  };
  await anthropic.streamResponse(normal);
  const wire = structuredClone(stream.mock.calls[0][0]);
  await anthropic.streamResponse({
    ...normal,
    messages: [...messages, { role: "user", content: "SUMMARIZE" }],
    promptCache: { ...normal.promptCache, messageBoundary: 6 },
  });
  const summaryWire = stream.mock.calls[1][0];
  expect(summaryWire.messages.slice(0, -1)).toEqual(wire.messages);
  expect(summaryWire.messages.at(-1)).toEqual({
    role: "user",
    content: "SUMMARIZE",
  });
  expect(wire.messages).toHaveLength(2);
  expect(wire.messages[1]).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "TOOL-A" },
      { type: "tool_result", tool_use_id: "b", content: "TOOL-B" },
      { type: "text", text: "STEER" },
      { type: "text", text: "<system-reminder>ENV</system-reminder>" },
      { type: "text", text: "<system-reminder>MODE</system-reminder>" },
      {
        type: "text",
        text: "STEP-LIMIT",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  await anthropic.streamResponse(normal);
  expect(stream.mock.calls[2][0]).toEqual(wire);

  const responses = createOpenAIResponsesProvider({
    id: "openai",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
  });
  const responseCreate = vi
    .spyOn(responses.client.responses, "create")
    .mockResolvedValue(emptyStream() as never);
  await responses.streamResponse({
    ...normal,
    model: "gpt",
    promptCache: observeOnly(),
  });
  const responsesWire = responseCreate.mock.calls[0][0];
  expect(responsesWire.instructions).toBe("HOST");
  expect(responsesWire.input).toEqual([
    { type: "function_call", call_id: "a", name: "lookup", arguments: "{}" },
    { type: "function_call", call_id: "b", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "TOOL-A" },
    { type: "function_call_output", call_id: "b", output: "TOOL-B" },
    { role: "user", content: "STEER" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "<system-reminder>ENV</system-reminder>" },
        { type: "input_text", text: "<system-reminder>MODE</system-reminder>" },
      ],
    },
    { role: "user", content: "STEP-LIMIT" },
  ]);
  const chat = createOpenAICompatibleProvider({
    id: "openai",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
  });
  const chatCreate = vi
    .spyOn(chat.client.chat.completions, "create")
    .mockResolvedValue(emptyStream<ChatCompletionChunk>() as never);
  await chat.streamResponse({
    ...normal,
    model: "gpt",
    promptCache: observeOnly(),
  });
  expect(chatCreate.mock.calls[0][0].messages.slice(2)).toEqual([
    { role: "tool", tool_call_id: "a", content: "TOOL-A" },
    { role: "tool", tool_call_id: "b", content: "TOOL-B" },
    { role: "user", content: "STEER" },
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>ENV</system-reminder>" },
        { type: "text", text: "<system-reminder>MODE</system-reminder>" },
      ],
    },
    { role: "user", content: "STEP-LIMIT" },
  ]);
  for (const payload of [
    wire,
    summaryWire,
    responsesWire,
    chatCreate.mock.calls[0][0],
  ])
    expect(JSON.stringify(payload)).not.toContain('"source"');
});
