import { describe, expect, it } from "vitest";
import { createContextSummaryClient } from "./prompt-context.js";
import type { LLMClientInstance } from "../../core/llm-client/types.js";
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
        history: [],
        prompt: "summarize",
        sessionId: "s",
      });
      if (ending === "stop") await expect(result).resolves.toBe("Summary text");
      else await expect(result).rejects.toThrow();
    },
  );
});
