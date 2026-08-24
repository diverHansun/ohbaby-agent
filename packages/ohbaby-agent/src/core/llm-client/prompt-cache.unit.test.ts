import { describe, expect, it } from "vitest";
import type {
  InterfaceProviderKind,
  InterfaceProviderPromptCache,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import type { LLMClientInstance } from "./types.js";
import { streamChatCompletion } from "./streaming.js";
import {
  createScopedPromptCacheKey,
  resolvePromptCacheRequest,
  resolvePromptCacheStrategy,
} from "./prompt-cache.js";

describe("prompt cache capability resolver", () => {
  it.each<{
    readonly baseUrl: string;
    readonly interfaceProvider: InterfaceProviderKind;
    readonly provider: string;
    readonly strategy:
      | "observe-only"
      | "openai-keyed-implicit"
      | "anthropic-top-level-auto"
      | "anthropic-explicit-last-block";
  }>([
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/",
      interfaceProvider: "openai-compatible",
      strategy: "openai-keyed-implicit",
    },
    {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      interfaceProvider: "anthropic",
      strategy: "anthropic-top-level-auto",
    },
    {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      interfaceProvider: "openai-compatible",
      strategy: "observe-only",
    },
    {
      provider: "zhipu",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      interfaceProvider: "openai-compatible",
      strategy: "observe-only",
    },
    {
      provider: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      interfaceProvider: "openai-compatible",
      strategy: "observe-only",
    },
    {
      provider: "kimi-code",
      baseUrl: "https://api.kimi.com/coding/v1",
      interfaceProvider: "openai-compatible",
      strategy: "observe-only",
    },
    {
      provider: "zenmux",
      baseUrl: "https://zenmux.ai/api/v1",
      interfaceProvider: "openai-compatible",
      strategy: "observe-only",
    },
    {
      provider: "zenmux",
      baseUrl: "https://zenmux.ai/api/anthropic/v1",
      interfaceProvider: "anthropic",
      strategy: "anthropic-explicit-last-block",
    },
    {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      interfaceProvider: "anthropic",
      strategy: "observe-only",
    },
    {
      provider: "custom",
      baseUrl: "https://gateway.example.com/v1",
      interfaceProvider: "openai-compatible",
      strategy: "observe-only",
    },
  ])(
    "$provider $baseUrl $interfaceProvider -> $strategy",
    ({ strategy, ...input }) => {
      expect(
        resolvePromptCacheStrategy({ ...input, policy: "auto" }).strategy,
      ).toBe(strategy);
    },
  );

  it("uses conservative native strategies only when the user explicitly enables them", () => {
    expect(
      resolvePromptCacheStrategy({
        baseUrl: "https://gateway.example.com/v1",
        interfaceProvider: "openai-compatible",
        policy: "enabled",
        provider: "custom",
      }).strategy,
    ).toBe("openai-keyed-implicit");
    expect(
      resolvePromptCacheStrategy({
        baseUrl: "https://gateway.example.com/anthropic",
        interfaceProvider: "anthropic",
        policy: "enabled",
        provider: "custom",
      }).strategy,
    ).toBe("anthropic-explicit-last-block");
  });

  it("never grants official capability from provider id or deceptive URLs", () => {
    for (const baseUrl of [
      "https://evil-openai.com/v1",
      "https://api.openai.com.evil.example/v1",
      "http://api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://api.openai.com/v1/chat",
      "https://api.openai.com/v1?proxy=1",
    ]) {
      expect(
        resolvePromptCacheStrategy({
          baseUrl,
          interfaceProvider: "openai-compatible",
          policy: "auto",
          provider: "openai",
        }).strategy,
      ).toBe("observe-only");
    }
  });

  it("disabled suppresses request controls even for official endpoints", () => {
    expect(
      resolvePromptCacheStrategy({
        baseUrl: "https://api.openai.com/v1",
        interfaceProvider: "openai-compatible",
        policy: "disabled",
        provider: "openai",
      }).strategy,
    ).toBe("observe-only");
  });

  it("degrades explicit Anthropic caching when no eligible block exists", () => {
    const promptCache = resolvePromptCacheRequest({
      baseUrl: "https://gateway.example.test/anthropic",
      interfaceProvider: "anthropic",
      messages: [],
      policy: "enabled",
      provider: "custom",
      purpose: "agent-step",
      sessionId: "session-a",
    });

    expect(promptCache.strategy).toBe("observe-only");
    expect(promptCache.reason).toContain("no eligible content block");
  });

  it("makes invalid wire-ready cache states fail type checking", () => {
    // @ts-expect-error keyed wire requests require a cache key
    const missingKey: InterfaceProviderPromptCache = {
      strategy: "openai-keyed-implicit",
      reason: "invalid fixture",
    };
    // @ts-expect-error non-keyed wire requests must not carry a cache key
    const observeWithKey: InterfaceProviderPromptCache = {
      strategy: "observe-only",
      reason: "invalid fixture",
      key: "forbidden",
    };

    expect([missingKey, observeWithKey]).toHaveLength(2);
  });
});

describe("scoped prompt cache identity", () => {
  it("is stable within a primary session and across provider-irrelevant changes", () => {
    const first = createScopedPromptCacheKey({ sessionId: "session secret" });
    const second = createScopedPromptCacheKey({ sessionId: "session secret" });
    expect(second).toBe(first);
    expect(first).toMatch(/^ob:v1:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("session secret");
  });

  it("reuses the same resolved key for every transport retry", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const retryable = Object.assign(new Error("rate limited"), { status: 429 });
    let attempt = 0;
    const client = fakeClient((request) => {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(retryable);
      }
      return Promise.resolve(providerStream([{ finishReason: "stop" }]));
    });

    const runtimeMarker =
      "<environment_context>retry-runtime</environment_context>";
    for await (const _ of streamChatCompletion(
      client,
      [{ role: "user", content: `Hello\n\n${runtimeMarker}` }],
      {
        purpose: "agent-step",
        retry: {
          initialDelayMs: 0,
          maxDelayMs: 0,
          maxRetriesPerStep: 1,
          retryAfterCapMs: 0,
        },
        sessionId: "session-a",
      },
    )) {
      // Drain both the retry notice and successful terminal response.
    }

    expect(requests).toHaveLength(2);
    expect(requests[0]?.promptCache.key).toBe(requests[1]?.promptCache.key);
    expect(requests[1]?.messages).toEqual(requests[0]?.messages);
    expect(
      JSON.stringify(requests[1]?.messages).split(runtimeMarker),
    ).toHaveLength(2);
  });

  it("keeps the selected explicit strategy in provider refusal errors", async () => {
    const client = fakeClient(() => Promise.reject(new Error("unsupported")));
    const consume = async (): Promise<void> => {
      for await (const _ of streamChatCompletion(
        client,
        [{ role: "user", content: "Hello" }],
        { purpose: "agent-step", sessionId: "session-a" },
      )) {
        // Drain the request.
      }
    };

    await expect(consume()).rejects.toThrow(
      /prompt-cache strategy=openai-keyed-implicit/u,
    );
  });

  it("preserves frozen provider errors as the cause of strategy diagnostics", async () => {
    const frozen = Object.freeze(new Error("frozen provider error"));
    const client = fakeClient(() => Promise.reject(frozen));
    let caught: unknown;
    try {
      await drain(
        streamChatCompletion(client, [{ role: "user", content: "Hello" }], {
          purpose: "agent-step",
          sessionId: "session-a",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "prompt-cache strategy=openai-keyed-implicit",
    );
    expect((caught as Error).cause).toBe(frozen);
  });

  it("isolates sessions, primary context, and every child context scope", () => {
    const keys = new Set([
      createScopedPromptCacheKey({ sessionId: "session-a" }),
      createScopedPromptCacheKey({
        sessionId: "session-a",
        contextScopeId: "subagent-a",
      }),
      createScopedPromptCacheKey({
        sessionId: "session-a",
        contextScopeId: "subagent-b",
      }),
      createScopedPromptCacheKey({ sessionId: "session-b" }),
    ]);
    expect(keys.size).toBe(4);
    expect([...keys].join(" ")).not.toContain("subagent-a");
    expect([...keys].join(" ")).not.toContain("subagent-b");
  });

  it("keeps final request keys stable across append, compact, and tool-menu changes", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const client = fakeClient(
      (request) => {
        requests.push(request);
        return Promise.resolve(providerStream([{ finishReason: "stop" }]));
      },
      {
        baseUrl: "https://api.openai.com/v1",
        promptCache: "auto",
        provider: "openai",
      },
    );
    const options = {
      purpose: "agent-step" as const,
      sessionId: "session-a",
    };

    await drain(
      streamChatCompletion(
        client,
        [{ role: "user", content: "First" }],
        options,
      ),
    );
    await drain(
      streamChatCompletion(
        client,
        [
          { role: "user", content: "First" },
          { role: "assistant", content: "Answer" },
          { role: "user", content: "Continue" },
        ],
        options,
      ),
    );
    await drain(
      streamChatCompletion(
        client,
        [
          {
            role: "user",
            content: "<context_summary>compact</context_summary>",
          },
          { role: "user", content: "Continue" },
        ],
        {
          ...options,
          tools: [
            {
              type: "function",
              function: {
                name: "mcp_loaded_tool",
                description: "Loaded in a later tool-menu epoch",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        },
      ),
    );

    expect(requests).toHaveLength(3);
    expect(
      new Set(requests.map((request) => request.promptCache.key)).size,
    ).toBe(1);
  });

  it("forces auxiliary and legacy calls to observe-only", () => {
    const base = {
      baseUrl: "https://api.openai.com/v1",
      interfaceProvider: "openai-compatible" as const,
      policy: "auto" as const,
      provider: "openai",
      sessionId: "session-a",
    };
    expect(resolvePromptCacheRequest(base).strategy).toBe("observe-only");
    expect(
      resolvePromptCacheRequest({ ...base, purpose: "context-summary" })
        .strategy,
    ).toBe("observe-only");
    expect(
      resolvePromptCacheRequest({ ...base, purpose: "session-title" }).strategy,
    ).toBe("observe-only");
    expect(
      resolvePromptCacheRequest({
        ...base,
        purpose: "agent-step",
        sessionId: undefined,
      }).strategy,
    ).toBe("observe-only");
  });
});

function fakeClient(
  send: (
    request: InterfaceProviderRequest,
  ) => Promise<AsyncIterable<InterfaceProviderStreamEvent>>,
  config: Partial<LLMClientInstance["config"]> = {},
): LLMClientInstance {
  return {
    config: {
      baseUrl: "https://gateway.example.test/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "model",
      promptCache: "enabled",
      provider: "custom",
      temperature: 0,
      ...config,
    },
    provider: {
      client: {},
      id: "custom",
      isAbortError: () => false,
      kind: "openai-compatible",
      streamChatCompletion: send,
    },
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // Drain the shared stream so the adapter request reaches its terminal event.
  }
}

function providerStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncIterable<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}
