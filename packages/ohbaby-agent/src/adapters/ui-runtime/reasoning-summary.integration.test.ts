import { expect, it } from "vitest";
import { createContextSummaryClient } from "./prompt-context.js";
import { streamResponse } from "../../core/llm-client/streaming.js";
import type { LLMClientInstance } from "../../core/llm-client/types.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/types.js";
import { mergeReasoningIntent } from "../../services/interface-providers/reasoning.js";

it("concurrent agent summaries send their own reasoning snapshot while the shared client changes", async () => {
  const requests: InterfaceProviderRequest[] = [];
  const client: LLMClientInstance = {
    config: {
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      interfaceProvider: "openai-responses",
      maxTokens: 8192,
      reasoning: { effort: "low" },
    },
    provider: {
      id: "openai",
      kind: "openai-responses",
      client: {},
      isAbortError: () => false,
      async streamResponse(request) {
        requests.push(request);
        await Promise.resolve();
        return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
          await Promise.resolve();
          yield { textDelta: "Summary", finishReason: "stop" };
        })();
      },
    },
  };
  const summaries = createContextSummaryClient(client);
  const first = summaries.generateSummary({
    sessionId: "parent",
    contextScopeId: "child-high",
    prompt: "summarize",
    history: [],
    reasoning: mergeReasoningIntent({ effort: "high" }),
  });
  const second = summaries.generateSummary({
    sessionId: "parent",
    contextScopeId: "child-off",
    prompt: "summarize",
    history: [],
    reasoning: mergeReasoningIntent({ enabled: false, effort: "high" }),
  });
  client.config.reasoning = { effort: "medium" };
  await expect(Promise.all([first, second])).resolves.toEqual([
    "Summary",
    "Summary",
  ]);
  expect(
    requests.map((request) => [
      request.contextScopeId,
      request.reasoning?.mode,
      request.reasoning?.effort,
    ]),
  ).toEqual([
    ["child-high", "effort", "high"],
    ["child-off", "disabled", undefined],
  ]);
  expect(client.config.reasoning).toEqual({ effort: "medium" });
  for await (const _frame of streamResponse(client, [
    { role: "user", content: "next run" },
  ])) {
    /* consume */
  }
  expect(requests[2].reasoning?.effort).toBe("medium");
});

it("summarizes with the child model and validates inherited intent against that model", async () => {
  const requests: InterfaceProviderRequest[] = [];
  const client: LLMClientInstance = {
    config: {
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      interfaceProvider: "openai-responses",
      maxTokens: 8192,
    },
    provider: {
      id: "openai",
      kind: "openai-responses",
      client: {},
      isAbortError: () => false,
      async streamResponse(request) {
        requests.push(request);
        await Promise.resolve();
        return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
          yield await Promise.resolve({
            textDelta: "Child summary",
            finishReason: "stop",
          });
        })();
      },
    },
  };
  const summaries = createContextSummaryClient(client);
  await expect(
    summaries.generateSummary({
      sessionId: "children",
      contextScopeId: "child",
      modelId: "gpt-4o",
      prompt: "summarize",
      history: [],
      reasoning: mergeReasoningIntent(),
    }),
  ).resolves.toBe("Child summary");
  expect(requests[0].model).toBe("gpt-4o");
  expect(requests[0].reasoning?.mode).toBe("none");
  await expect(
    summaries.generateSummary({
      sessionId: "children",
      contextScopeId: "child",
      modelId: "gpt-4o",
      prompt: "summarize",
      history: [],
      reasoning: mergeReasoningIntent({ effort: "high" }),
    }),
  ).rejects.toThrow(/does not support reasoning/);
  expect(requests).toHaveLength(1);
  expect(client.config.model).toBe("gpt-5.2");
});
