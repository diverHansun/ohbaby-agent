import { resolvePreparedRequestSettings } from "../../core/llm-client/streaming.js";
import { describe, expect, it } from "vitest";
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

it.each(["eof", "transport"] as const)(
  "retains trailing usage when rejecting tool output followed by %s",
  async (ending) => {
    let calls = 0;
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
              toolCallDeltas: [
                { index: 0, id: "call", name: "read", argumentsDelta: "{}" },
              ],
              finishReason: "tool_calls",
            };
            yield { tokenUsage: usage };
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
        onRequestRecord: (record) => records.push(record),
      }),
    ).rejects.toThrow("attempted a tool call");
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: ending === "eof" ? "success" : "error",
      usage,
    });
  },
);
