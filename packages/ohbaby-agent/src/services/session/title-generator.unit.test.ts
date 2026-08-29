import { describe, expect, it, vi } from "vitest";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import { sessionTitleGenerationFailed } from "../../observability/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../interface-providers/index.js";
import {
  cleanGeneratedSessionTitle,
  generateSessionTitle,
  TITLE_GENERATION_MAX_TOKENS,
} from "./title-generator.js";

describe("session title generator", () => {
  it("cleans model wrappers from generated titles", () => {
    expect(
      cleanGeneratedSessionTitle(
        '<think>pick short words</think>\n```json\n{"title":"\\"修复登录超时\\""}\n```',
      ),
    ).toBe("修复登录超时");
    expect(cleanGeneratedSessionTitle("- Refactor session picker")).toBe(
      "Refactor session picker",
    );
  });

  it("caps title output per request without touching the client config", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const client = createFakeLLMClient(
      [
        { textDelta: "<think>hidden</think>" },
        { textDelta: '{"title":"Sessions UI cards"}' },
        { finishReason: "stop" },
      ],
      requests,
    );

    const title = await generateSessionTitle({
      firstUserMessage: "Please fix sessions. OPENAI_API_KEY=sk-secret-value",
      llmClient: client,
      sessionId: "session_1",
    });

    expect(title).toBe("Sessions UI cards");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      maxTokens: TITLE_GENERATION_MAX_TOKENS,
      model: "active-model",
      purpose: "session-title",
      sessionId: "session_1",
      temperature: 0.8,
    });
    expect(client.config.maxTokens).toBe(8192);
    expect(JSON.stringify(requests[0].messages)).toContain("[redacted]");
    expect(JSON.stringify(requests[0].messages)).not.toContain(
      "sk-secret-value",
    );
  });

  it("does not persist the empty-response placeholder as a generated title", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const client = createFakeLLMClient([{ finishReason: "stop" }], requests);

    await expect(
      generateSessionTitle({
        firstUserMessage: "hello?之前我们讨论了什么？",
        llmClient: client,
      }),
    ).resolves.toBeNull();
  });

  it("accepts canonical auxiliary usage without exposing it as session state", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const client = createFakeLLMClient(
      [
        { textDelta: "Cache-aware title" },
        {
          finishReason: "stop",
          tokenUsage: {
            inputBreakdown: {
              cacheRead: 80,
              cacheWrite: 0,
              observed: { cacheRead: true, cacheWrite: false },
              uncached: 20,
            },
            inputTokens: 100,
            outputTokens: 3,
            totalTokens: 103,
          },
        },
      ],
      requests,
    );

    await expect(
      generateSessionTitle({ firstUserMessage: "Name it", llmClient: client }),
    ).resolves.toBe("Cache-aware title");
  });

  it("emits a structured diagnostic when title generation fails", async () => {
    const failure = new Error("provider offline");
    const client = createRejectingLLMClient(failure);
    const emit = vi.fn();

    await expect(
      generateSessionTitle({
        firstUserMessage: "Please name this session",
        llmClient: client,
        logger: { emit },
      }),
    ).resolves.toBeNull();

    expect(emit).toHaveBeenCalledWith(sessionTitleGenerationFailed, {
      error: failure,
    });
  });

  it("does not let an injected logger failure replace the product result", async () => {
    const client = createRejectingLLMClient(new Error("provider offline"));

    await expect(
      generateSessionTitle({
        firstUserMessage: "Please name this session",
        llmClient: client,
        logger: {
          emit(): never {
            throw new Error("diagnostics adapter failed");
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("stays silent on process stderr when no logger is injected", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const client = createRejectingLLMClient(new Error("provider offline"));

      await expect(
        generateSessionTitle({
          firstUserMessage: "Please name this session",
          llmClient: client,
        }),
      ).resolves.toBeNull();

      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("returns null when title generation times out", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const client = createNeverResolvingLLMClient(requests);

    await expect(
      generateSessionTitle({
        firstUserMessage: "Please name this session",
        llmClient: client,
        timeoutMs: 1,
      }),
    ).resolves.toBeNull();
    expect(requests[0]?.signal?.aborted).toBe(true);
  });
});

function createFakeLLMClient(
  events: readonly InterfaceProviderStreamEvent[],
  requests: InterfaceProviderRequest[],
): LLMClientInstance<{ readonly kind: "fake" }> {
  return {
    config: {
      apiKeyEnv: "ACTIVE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 8192,
      model: "active-model",
      provider: "active-provider",
      temperature: 0.8,
    },
    provider: {
      client: { kind: "fake" },
      id: "active-provider",
      isAbortError(): boolean {
        return false;
      },
      kind: "openai-compatible",
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        return Promise.resolve(createProviderStream(events));
      },
    },
  };
}

function createRejectingLLMClient(
  error: Error,
): LLMClientInstance<{ readonly kind: "fake" }> {
  const requests: InterfaceProviderRequest[] = [];
  const client = createFakeLLMClient([], requests);
  return {
    ...client,
    provider: {
      ...client.provider,
      streamChatCompletion(): Promise<
        AsyncIterable<InterfaceProviderStreamEvent>
      > {
        return Promise.reject(error);
      },
    },
  };
}

function createNeverResolvingLLMClient(
  requests: InterfaceProviderRequest[],
): LLMClientInstance<{ readonly kind: "fake" }> {
  const client = createFakeLLMClient([], requests);
  return {
    ...client,
    provider: {
      ...client.provider,
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        return new Promise(() => {
          // Keep this provider pending so the timeout path owns completion.
        });
      },
    },
  };
}

function createProviderStream(
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
