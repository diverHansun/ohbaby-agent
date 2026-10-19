import { resolvePreparedRequestSettings } from "../../core/llm-client/streaming.js";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createContextManager } from "../../core/context/context-manager.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createAnthropicProvider } from "../../services/interface-providers/anthropic.js";
import { createContextSummaryClient } from "./prompt-context.js";
import type {
  LLMClientInstance,
  SummaryRequestRecord,
} from "../../core/llm-client/types.js";
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";

describe("summary completion through the production stream accumulator", () => {
  it.each([
    "stop",
    "length",
    "content_filter",
    "tool_calls",
    "eof",
    "late-error",
  ] as const)(
    "handles %s without mistaking partial text for a successful summary",
    async (ending) => {
      const client: LLMClientInstance = {
        config: {
          provider: "openai",
          model: "gpt-5.2",
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-responses",
          maxTokens: 128,
        },
        provider: {
          id: "openai",
          kind: "openai-responses",
          client: {},
          isAbortError: () => false,
          async streamResponse() {
            await Promise.resolve();
            return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              await Promise.resolve();
              yield {
                textDelta: "Summary text",
                ...(ending === "eof"
                  ? {}
                  : {
                      finishReason: ending === "late-error" ? "stop" : ending,
                    }),
              };
              if (ending === "late-error")
                throw new Error("fixture failed after completion");
            })();
          },
        },
      };
      const result = createContextSummaryClient(client).generateSummary({
        request: {
          messages: [{ role: "user", content: "summarize" }],
          tools: undefined,
          settings: {
            ...resolvePreparedRequestSettings(client),
            maxTokens: 32768,
          },
        },
        summaryMessageId: "summary",
        compactionId: "compact",
        attempt: 1,
        sessionId: "s",
      });
      if (ending === "stop")
        await expect(result).resolves.toMatchObject({ text: "Summary text" });
      else await expect(result).rejects.toThrow();
    },
  );
});

it.each(
  (["length", "content_filter", "tool_calls"] as const).flatMap((finish) =>
    (["eof", "transport", "abort"] as const).map((ending) => ({
      finish,
      ending,
    })),
  ),
)(
  "retains trailing usage when rejecting $finish followed by $ending",
  async ({ finish, ending }) => {
    let calls = 0;
    const controller = new AbortController();
    const records: SummaryRequestRecord[] = [];
    const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
    const client: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        baseUrl: "https://fixture.invalid",
        interfaceProvider: "openai-compatible",
        maxTokens: 16384,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        async streamResponse() {
          calls++;
          await Promise.resolve();
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            await Promise.resolve();
            yield {
              ...(finish === "tool_calls"
                ? {
                    toolCallDeltas: [
                      {
                        index: 0,
                        id: "call",
                        name: "read",
                        argumentsDelta: "{}",
                      },
                    ],
                  }
                : { textDelta: "Incomplete summary" }),
              finishReason: finish,
            };
            yield { tokenUsage: usage };
            if (ending === "abort") controller.abort();
            if (ending === "transport")
              throw Object.assign(new Error("connection reset"), {
                code: "ECONNRESET",
              });
          })();
        },
      },
    };
    await expect(
      createContextSummaryClient(client).generateSummary({
        request: {
          messages: [{ role: "user", content: "summarize" }],
          tools: [{ name: "read", inputSchema: {} }],
          settings: resolvePreparedRequestSettings(client),
        },
        summaryMessageId: "summary",
        compactionId: "compact",
        attempt: 1,
        sessionId: "s",
        signal: controller.signal,
        onRequestRecord: (record) => records.push(record),
      }),
    ).rejects.toThrow(
      ending === "abort"
        ? "aborted"
        : finish === "tool_calls"
          ? "attempted a tool call"
          : "did not finish normally",
    );
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome:
        ending === "eof" ? "success" : ending === "abort" ? "aborted" : "error",
      usage,
    });
  },
);

it.each([
  { terminal: true, expectedCalls: 1, expectedStatus: "failed" },
  { terminal: false, expectedCalls: 2, expectedStatus: "compacted" },
] as const)(
  "bounds Anthropic summary retries after transport loss (length already received: $terminal)",
  async ({ terminal, expectedCalls, expectedStatus }) => {
    const provider = createAnthropicProvider({
      id: "fixture",
      apiKey: "local-fixture-only",
      baseUrl: "https://fixture.invalid",
    });
    let calls = 0;
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockImplementation(() => {
        const attempt = ++calls;
        return (async function* (): AsyncGenerator<RawMessageStreamEvent> {
          await Promise.resolve();
          yield {
            type: "message_start",
            message: {
              id: `msg_${String(attempt)}`,
              type: "message",
              role: "assistant",
              model: "fixture",
              content: [],
              container: null,
              stop_details: null,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 65000,
                output_tokens: 0,
                cache_creation: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                inference_geo: null,
                output_tokens_details: null,
                server_tool_use: null,
                service_tier: null,
              },
            },
          };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Summary text" },
          };
          yield { type: "content_block_stop", index: 0 };
          if (attempt > 1 || terminal) {
            yield {
              type: "message_delta",
              delta: {
                container: null,
                stop_details: null,
                stop_reason: attempt === 1 ? "max_tokens" : "end_turn",
                stop_sequence: null,
              },
              usage: {
                output_tokens: attempt === 1 ? 16384 : 3,
                input_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                output_tokens_details: null,
                server_tool_use: null,
              },
            };
          }
          if (attempt === 1)
            throw Object.assign(new Error("connection reset"), {
              code: "ECONNRESET",
            });
          yield { type: "message_stop" };
        })();
      });
    const client: LLMClientInstance = {
      provider,
      config: {
        provider: "fixture",
        model: "fixture",
        baseUrl: "https://fixture.invalid",
        interfaceProvider: "anthropic",
        maxTokens: 8192,
        promptCache: "disabled",
      },
    };
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    for (let index = 0; index < 8; index++) {
      const message = await messages.createMessage({
        sessionId: "summary-retry",
        role: index % 2 ? "assistant" : "user",
        agent: "primary",
      });
      await messages.appendPart(message.id, {
        type: "text",
        text: `history-${String(index)}: ${"x".repeat(8000)}`,
      });
    }
    const before = await messages.listBySession("summary-retry");
    const records: SummaryRequestRecord[] = [];
    const summaryClient = createContextSummaryClient(client);
    const manager = createContextManager({
      bus,
      messageManager: messages,
      llmClient: {
        generateSummary(input) {
          return summaryClient.generateSummary({
            ...input,
            onRequestRecord(record) {
              records.push(record);
              input.onRequestRecord?.(record);
            },
          });
        },
      },
      systemPromptProvider: { build: () => Promise.resolve("Stable system") },
      tokenCounter: {
        estimateTokens: (text) => text.length,
        getLimit: () => 128000,
      },
    });
    try {
      const result = await manager.compact("summary-retry", {
        directory: "/repo",
        force: true,
        modelId: "fixture",
        toolNames: [],
        tools: undefined,
        requestSettings: resolvePreparedRequestSettings(client),
      });
      expect(calls).toBe(expectedCalls);
      expect(result.status).toBe(expectedStatus);
      expect(records).toHaveLength(expectedCalls);
      if (terminal) {
        expect(records[0]).toMatchObject({
          outcome: "error",
          usage: { inputTokens: 65000, outputTokens: 16384 },
        });
        expect(await messages.listBySession("summary-retry")).toEqual(before);
      }
    } finally {
      stream.mockRestore();
    }
  },
);
