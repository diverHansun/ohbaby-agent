/**
 * Integration tests for the LLM Client module.
 *
 * Tests the createLLMClient and streamChatCompletion functions
 * with mocked config module and OpenAI API responses.
 */

import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import * as path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import {
  createLLMClient,
  isRetryableProviderError,
  nextRetryDelayMs,
  parseRetryAfterMs,
  ProviderStreamInterruptedError,
  retryReason,
  streamChatCompletion,
  ToolCallParseError,
} from "./index.js";
import type {
  ChatCompletionMessage,
  LLMClientInstance,
  StreamingResponse,
} from "./types.js";

type AssistantMessage = Extract<ChatCompletionMessage, { role: "assistant" }>;
type ConfigErrorWithCode = Error & { code: string };

interface MockSdkClient {
  chat: {
    completions: {
      create: () => void;
    };
  };
}

interface OpenAIClientLike {
  chat: {
    completions: {
      create: unknown;
    };
  };
}

function createProviderStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
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

function createAbortingProviderStream(
  events: readonly InterfaceProviderStreamEvent[],
  error: Error,
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }

    throw error;
  })();
}

let streamChatCompletionMock: ReturnType<
  typeof vi.fn<
    (
      request: InterfaceProviderRequest,
    ) => Promise<AsyncIterable<InterfaceProviderStreamEvent>>
  >
>;
let isAbortErrorMock: ReturnType<typeof vi.fn<(error: unknown) => boolean>>;

function getInterfaceProviderRequest(): InterfaceProviderRequest {
  const request = streamChatCompletionMock.mock.calls[0][0];
  return request;
}

function getAssistantMessage(response: StreamingResponse): AssistantMessage {
  expect(response.completeMessage.role).toBe("assistant");
  return response.completeMessage as AssistantMessage;
}

// Mock the config module
vi.mock("../../config/index.js", () => ({
  getLLMConfig: vi.fn(),
}));

import { getLLMConfig } from "../../config/index.js";
import type { LLMConfig } from "../../config/index.js";

describe("LLM Client Integration Tests", () => {
  const mockConfig: LLMConfig = {
    provider: "openai",
    model: "gpt-4",
    apiKey: "sk-test-123",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    interfaceProvider: "openai-compatible",
    temperature: 0.7,
    maxTokens: 4096,
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("createLLMClient", () => {
    it("should create client with config from config module", async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      expect(client).toBeDefined();
      expect(client.provider).toBeDefined();
      expect(client.provider.client).toBeDefined();
      expect(client.config).toBeDefined();
      expect(client.config.provider).toBe("openai");
      expect(client.config.model).toBe("gpt-4");
      expect(client.config.baseUrl).toBe("https://api.openai.com/v1");
      expect(client.config.apiKeyEnv).toBe("OPENAI_API_KEY");
      expect(client.config.interfaceProvider).toBe("openai-compatible");
      expect(client.config.temperature).toBe(0.7);
      expect(client.config.maxTokens).toBe(4096);
      expect("client" in client).toBe(false);
    });

    it("should pass project directory to config loading", async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      await createLLMClient({ projectDirectory: "D:/repo" });

      expect(getLLMConfig).toHaveBeenCalledWith({
        envPath: path.join("D:/repo", ".env"),
        projectDirectory: "D:/repo",
      });
    });

    it("should not expose apiKey in returned config", async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      // apiKey should not be in the config object
      expect("apiKey" in client.config).toBe(false);
    });

    it("should use different provider config", async () => {
      const zhipuConfig: LLMConfig = {
        provider: "zhipu",
        model: "glm-4-plus",
        apiKey: "zhipu-key-123",
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        temperature: 0.2,
        maxTokens: 2048,
      };
      vi.mocked(getLLMConfig).mockResolvedValue(zhipuConfig);

      const client = await createLLMClient();

      expect(client.config.provider).toBe("zhipu");
      expect(client.config.model).toBe("glm-4-plus");
      expect(client.config.baseUrl).toBe(
        "https://open.bigmodel.cn/api/paas/v4",
      );
      expect(client.config.temperature).toBe(0.2);
      expect(client.config.maxTokens).toBe(2048);
    });

    it("should propagate ConfigError from config module", async () => {
      const configError = new Error(
        "Configuration file not found",
      ) as ConfigErrorWithCode;
      configError.code = "FILE_NOT_FOUND";
      vi.mocked(getLLMConfig).mockRejectedValue(configError);

      await expect(createLLMClient()).rejects.toThrow(
        "Configuration file not found",
      );
    });

    it("should expose the provider SDK client through provider.client", async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();
      const providerClient = client.provider.client as OpenAIClientLike;

      expect(providerClient.chat).toBeDefined();
      expect(providerClient.chat.completions).toBeDefined();
      expect(typeof providerClient.chat.completions.create).toBe("function");
    });
  });

  describe("streamChatCompletion", () => {
    let mockClient: LLMClientInstance<MockSdkClient>;

    beforeEach(() => {
      const sdkClient: MockSdkClient = {
        chat: {
          completions: {
            create: () => undefined,
          },
        },
      };
      streamChatCompletionMock =
        vi.fn<
          (
            request: InterfaceProviderRequest,
          ) => Promise<AsyncIterable<InterfaceProviderStreamEvent>>
        >();
      isAbortErrorMock = vi
        .fn<(error: unknown) => boolean>()
        .mockReturnValue(false);

      mockClient = {
        provider: {
          id: "openai",
          kind: "openai-compatible",
          client: sdkClient,
          streamChatCompletion: streamChatCompletionMock,
          isAbortError: isAbortErrorMock,
        },
        config: {
          provider: "openai",
          model: "gpt-4",
          apiKeyEnv: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-compatible",
          temperature: 0.7,
          maxTokens: 4096,
        },
      };
    });

    it("sends the configured maxTokens when no per-request override is given", async () => {
      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([{ textDelta: "ok", finishReason: "stop" }]),
      );

      const messages = [{ role: "user" as const, content: "Say hello" }];
      for await (const response of streamChatCompletion(mockClient, messages)) {
        void response;
      }

      expect(streamChatCompletionMock).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 4096 }),
      );
    });

    it("sends a per-request maxTokens override without touching client config", async () => {
      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([{ textDelta: "ok", finishReason: "stop" }]),
      );

      const messages = [{ role: "user" as const, content: "Say hello" }];
      for await (const response of streamChatCompletion(mockClient, messages, {
        maxTokens: 128,
      })) {
        void response;
      }

      expect(streamChatCompletionMock).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 128 }),
      );
      expect(mockClient.config.maxTokens).toBe(4096);
    });

    it("rejects invalid per-request maxTokens before calling the provider", async () => {
      const messages = [{ role: "user" as const, content: "Say hello" }];

      await expect(
        (async (): Promise<void> => {
          for await (const response of streamChatCompletion(
            mockClient,
            messages,
            { maxTokens: 0 },
          )) {
            void response;
          }
        })(),
      ).rejects.toThrow(/maxTokens.*positive integer/u);

      expect(streamChatCompletionMock).not.toHaveBeenCalled();
    });

    it("should accumulate text content from streaming chunks", async () => {
      const events: InterfaceProviderStreamEvent[] = [
        {
          textDelta: "Hello",
        },
        {
          textDelta: " world",
          finishReason: "stop",
          tokenUsage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ];

      streamChatCompletionMock.mockResolvedValue(createProviderStream(events));

      const messages = [{ role: "user" as const, content: "Say hello" }];
      const responses: StreamingResponse[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      expect(responses.length).toBe(2);

      // First chunk should have accumulated content
      expect(responses[0].completeMessage.content).toBe("Hello");
      expect(responses[0].isComplete).toBe(false);

      // Last chunk should have complete content
      expect(responses[1].completeMessage.content).toBe("Hello world");
      expect(responses[1].isComplete).toBe(true);
      expect(responses[1].finishReason).toBe("stop");
      expect(responses[1].rawFinishReason).toBeUndefined();
      expect(responses[1].tokenUsage?.total_tokens).toBe(15);
    });

    it("should accumulate and parse tool calls", async () => {
      const events: InterfaceProviderStreamEvent[] = [
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
          tokenUsage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
          },
        },
      ];

      streamChatCompletionMock.mockResolvedValue(createProviderStream(events));

      const messages = [
        { role: "user" as const, content: "Get weather for NYC" },
      ];
      const responses: StreamingResponse[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      const lastResponse = responses[responses.length - 1];
      const assistantMessage = getAssistantMessage(lastResponse);

      if (!("tool_calls" in assistantMessage) || !assistantMessage.tool_calls) {
        throw new Error("Expected tool calls on assistant message.");
      }

      // Verify raw tool call accumulation
      const toolCall = assistantMessage.tool_calls[0];
      expect(toolCall.id).toBe("call_123");
      expect(toolCall.function.name).toBe("get_weather");
      expect(toolCall.function.arguments).toBe('{"location":"NYC"}');

      // Verify parsed tool call
      const parsedCall = lastResponse.parsedToolCalls?.[0];
      expect(parsedCall?.name).toBe("get_weather");
      expect(parsedCall?.arguments).toEqual({ location: "NYC" });
    });

    it("should handle empty responses with default content", async () => {
      const events: InterfaceProviderStreamEvent[] = [
        {
          finishReason: "stop",
          tokenUsage: {
            prompt_tokens: 10,
            completion_tokens: 0,
            total_tokens: 10,
          },
        },
      ];

      streamChatCompletionMock.mockResolvedValue(createProviderStream(events));

      const messages = [{ role: "user" as const, content: "test" }];
      const responses: StreamingResponse[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      const lastResponse = responses[responses.length - 1];
      expect(lastResponse.completeMessage.content).toBe("(Empty response)");
    });

    it("should not expose provider reasoning deltas as assistant text", async () => {
      const events: InterfaceProviderStreamEvent[] = [
        { reasoningDelta: "hidden reasoning" },
        { textDelta: "Visible answer" },
        { finishReason: "stop" },
      ];

      streamChatCompletionMock.mockResolvedValue(createProviderStream(events));

      const messages = [{ role: "user" as const, content: "test" }];
      const responses: StreamingResponse[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      expect(
        responses.map((response) => response.completeMessage.content),
      ).toEqual(["Visible answer", "Visible answer"]);
    });

    it("should use configuration from client instance", async () => {
      mockClient.config.model = "gpt-4-turbo";
      mockClient.config.temperature = 1.0;
      mockClient.config.maxTokens = 128000;

      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([{ textDelta: "test", finishReason: "stop" }]),
      );

      const messages = [{ role: "user" as const, content: "test" }];

      const iterator = streamChatCompletion(mockClient, messages);
      await iterator.next();

      const callArgs = getInterfaceProviderRequest();

      expect(callArgs.model).toBe("gpt-4-turbo");
      expect(callArgs.temperature).toBe(1.0);
      expect(callArgs.maxTokens).toBe(128000);
    });

    it("should pass tools parameter to API", async () => {
      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([{ textDelta: "test", finishReason: "stop" }]),
      );

      const messages = [{ role: "user" as const, content: "use tool" }];
      const tools: ChatCompletionCreateParams["tools"] = [
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

      const iterator = streamChatCompletion(mockClient, messages, { tools });
      await iterator.next();

      const callArgs = getInterfaceProviderRequest();

      expect(callArgs.tools).toEqual(tools);
    });

    it("should pass abort signal to provider request", async () => {
      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([{ textDelta: "test", finishReason: "stop" }]),
      );

      const messages = [{ role: "user" as const, content: "test" }];
      const controller = new AbortController();
      const iterator = streamChatCompletion(mockClient, messages, {
        signal: controller.signal,
      });
      await iterator.next();

      const callArgs = getInterfaceProviderRequest();

      expect(callArgs.signal).toBe(controller.signal);
    });

    it("should return partial content when provider aborts mid-stream", async () => {
      const abortError = new Error("aborted");
      isAbortErrorMock.mockImplementation(
        (error: unknown) => error === abortError,
      );
      streamChatCompletionMock.mockResolvedValue(
        createAbortingProviderStream([{ textDelta: "Partial" }], abortError),
      );

      const responses: StreamingResponse[] = [];
      for await (const response of streamChatCompletion(mockClient, [
        { role: "user" as const, content: "test" },
      ])) {
        responses.push(response);
      }

      expect(responses).toHaveLength(2);
      expect(responses[0].isComplete).toBe(false);
      expect(responses[1]).toMatchObject({
        isComplete: true,
        streamStopReason: "user_aborted",
      });
      expect(responses[1].finishReason).toBeUndefined();
      expect(responses[1].completeMessage.content).toBe("Partial");
    });

    it("retries retryable provider errors before any stream delta is emitted", async () => {
      const unavailable = Object.assign(new Error("temporarily unavailable"), {
        status: 503,
      });
      streamChatCompletionMock
        .mockRejectedValueOnce(unavailable)
        .mockResolvedValueOnce(
          createProviderStream([
            { textDelta: "Recovered", finishReason: "stop" },
          ]),
        );

      const responses: StreamingResponse[] = [];
      for await (const response of streamChatCompletion(
        mockClient,
        [{ role: "user" as const, content: "test" }],
        {
          retry: {
            initialDelayMs: 0,
            maxDelayMs: 0,
            maxRetriesPerStep: 5,
            retryAfterCapMs: 0,
          },
        },
      )) {
        responses.push(response);
      }

      expect(streamChatCompletionMock).toHaveBeenCalledTimes(2);
      expect(responses[0]).toMatchObject({
        isComplete: false,
        retry: { attempt: 1, maxRetries: 5, reason: "server_error" },
      });
      expect(responses.at(-1)).toMatchObject({
        finishReason: "stop",
        isComplete: true,
        streamStopReason: "provider_finished",
      });
      expect(responses.at(-1)?.completeMessage.content).toBe("Recovered");
    });

    it("returns an aborted partial response when the signal aborts during retry sleep", async () => {
      vi.useFakeTimers();
      try {
        const unavailable = Object.assign(
          new Error("temporarily unavailable"),
          {
            status: 503,
          },
        );
        const controller = new AbortController();
        streamChatCompletionMock.mockRejectedValueOnce(unavailable);

        const responses: StreamingResponse[] = [];
        const consume = (async (): Promise<void> => {
          for await (const response of streamChatCompletion(
            mockClient,
            [{ role: "user" as const, content: "test" }],
            {
              retry: {
                initialDelayMs: 1_000,
                maxDelayMs: 1_000,
                maxRetriesPerStep: 5,
                retryAfterCapMs: 0,
              },
              signal: controller.signal,
            },
          )) {
            responses.push(response);
          }
        })();

        await vi.waitUntil(() =>
          responses.some((response) => response.retry !== undefined),
        );
        controller.abort("user cancelled");

        await expect(consume).resolves.toBeUndefined();
        expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
        expect(responses).toHaveLength(2);
        expect(responses[0]).toMatchObject({
          isComplete: false,
          retry: { attempt: 1, maxRetries: 5 },
        });
        expect(responses[1]).toMatchObject({
          isComplete: true,
          streamStopReason: "user_aborted",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("yields a complete empty assistant response when the provider stream has no events", async () => {
      streamChatCompletionMock.mockResolvedValue(createProviderStream([]));

      const responses: StreamingResponse[] = [];
      for await (const response of streamChatCompletion(mockClient, [
        { role: "user" as const, content: "test" },
      ])) {
        responses.push(response);
      }

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        completeMessage: { role: "assistant", content: "(Empty response)" },
        isComplete: true,
        streamStopReason: "provider_finished",
      });
    });

    it("does not replay a provider stream after a non-abort error follows emitted delta", async () => {
      const streamError = new Error("socket closed");
      streamChatCompletionMock.mockResolvedValueOnce(
        createAbortingProviderStream([{ textDelta: "Partial" }], streamError),
      );

      await expect(
        (async (): Promise<void> => {
          for await (const response of streamChatCompletion(
            mockClient,
            [{ role: "user" as const, content: "test" }],
            {
              retry: {
                initialDelayMs: 0,
                maxDelayMs: 0,
                maxRetriesPerStep: 5,
                retryAfterCapMs: 0,
              },
            },
          )) {
            void response;
          }
        })(),
      ).rejects.toBeInstanceOf(ProviderStreamInterruptedError);
      expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
    });

    it("classifies malformed tool call arguments as a parse error, not a stream interruption", async () => {
      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([
          {
            toolCallDeltas: [
              {
                index: 0,
                id: "call_bad",
                name: "get_weather",
                argumentsDelta: '{"location": broken',
              },
            ],
            finishReason: "tool_calls",
          },
        ]),
      );

      await expect(
        (async (): Promise<void> => {
          for await (const response of streamChatCompletion(mockClient, [
            { role: "user" as const, content: "test" },
          ])) {
            void response;
          }
        })(),
      ).rejects.toBeInstanceOf(ToolCallParseError);
      // A model output defect must not be retried.
      expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
    });

    it("should surface raw finish reason from provider events", async () => {
      streamChatCompletionMock.mockResolvedValue(
        createProviderStream([
          {
            textDelta: "Paused",
            finishReason: "stop",
            rawFinishReason: "pause_turn",
          },
        ]),
      );

      const responses: StreamingResponse[] = [];
      for await (const response of streamChatCompletion(mockClient, [
        { role: "user" as const, content: "test" },
      ])) {
        responses.push(response);
      }

      expect(responses[0].finishReason).toBe("stop");
      expect(responses[0].rawFinishReason).toBe("pause_turn");
    });
  });

  describe("Module exports", () => {
    it("should export createLLMClient and streamChatCompletion", () => {
      expect(typeof createLLMClient).toBe("function");
      expect(typeof streamChatCompletion).toBe("function");
    });

    it("should work with ES module imports", async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      expect(client).toBeDefined();
      const gen = streamChatCompletion(client, []);
      expect(typeof gen[Symbol.asyncIterator]).toBe("function");
    });
  });

  describe("retry helpers", () => {
    it("parses retry-after headers and caps explicit retry delays", () => {
      const error = {
        headers: {
          "retry-after-ms": "2500",
        },
      };

      expect(parseRetryAfterMs(error)).toBe(2500);
      expect(
        nextRetryDelayMs({
          attempt: 1,
          error,
          policy: {
            initialDelayMs: 100,
            maxDelayMs: 1_000,
            maxRetriesPerStep: 5,
            retryAfterCapMs: 1_000,
          },
          random: () => 0.5,
        }),
      ).toBe(1_000);
    });

    it("uses deterministic exponential backoff jitter when retry-after is absent", () => {
      expect(
        nextRetryDelayMs({
          attempt: 3,
          error: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
          policy: {
            initialDelayMs: 100,
            maxDelayMs: 1_000,
            maxRetriesPerStep: 5,
            retryAfterCapMs: 1_000,
          },
          random: () => 0.5,
        }),
      ).toBe(400);
    });

    it("classifies retriable transport and rate-limit errors without retrying conflicts", () => {
      expect(isRetryableProviderError({ status: 429 })).toBe(true);
      expect(isRetryableProviderError({ status: 503 })).toBe(true);
      expect(isRetryableProviderError({ code: "ECONNRESET" })).toBe(true);
      expect(isRetryableProviderError({ status: 409 })).toBe(false);
      expect(retryReason({ code: "ECONNRESET" })).toBe("econnreset");
    });
  });
});
