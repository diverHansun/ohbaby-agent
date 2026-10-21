import { describe, expect, it } from "vitest";
import { createContextSummaryClient } from "./prompt-context.js";
import type { LLMClientInstance } from "ohbaby-llm";
import type { SummaryRequestRecord } from "../../core/message/types.js";
import type { InterfaceProviderRequest } from "ohbaby-llm";
import { resolvePreparedRequestSettings } from "ohbaby-llm";

describe("prepared summary request", () => {
  it("sends the frozen normal settings and tool history, keeping summary usage out of ordinary ownership", async () => {
    const sent: InterfaceProviderRequest[] = [];
    const client: LLMClientInstance = {
      config: {
        provider: "openai",
        interfaceProvider: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2",
        maxTokens: 8192,
        reasoning: { effort: "high" },
      },
      provider: {
        id: "openai",
        kind: "openai-responses",
        client: {},
        isAbortError: () => false,
        async streamResponse(request) {
          await Promise.resolve();
          sent.push(request);
          return (async function* (): AsyncGenerator<
            import("ohbaby-llm").InterfaceProviderStreamEvent
          > {
            await Promise.resolve();
            yield {
              textDelta: "summary",
              finishReason: "stop" as const,
              tokenUsage: {
                inputTokens: 100,
                outputTokens: 10,
                totalTokens: 110,
                reasoningTokens: 3,
              },
            };
          })();
        },
      },
    };
    const settings = resolvePreparedRequestSettings(client);
    const records: SummaryRequestRecord[] = [];
    const messages = [
      { role: "system" as const, content: "original system" },
      { role: "user" as const, content: "original history" },
      { role: "user" as const, content: "summarize" },
    ];
    const tools = [{ name: "read", inputSchema: { type: "object" } }];
    client.config.reasoning = { effort: "low" };
    const result = await createContextSummaryClient(client).generateSummary({
      request: {
        messages,
        tools,
        inputIds: ["pending"],
        settings: { ...settings, maxTokens: 32768 },
      },
      sessionId: "s",
      contextScopeId: "child",
      summaryMessageId: "summary-id",
      compactionId: "compact-id",
      attempt: 2,
      onRequestRecord: (record) => records.push(record),
    });
    expect(result.text).toBe("summary");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      messages,
      tools,
      maxTokens: 32768,
      reasoning: { effort: "high" },
      purpose: "context-summary",
      sessionId: "s",
      contextScopeId: "child",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      compactionId: "compact-id",
      messageId: "summary-id",
      attempt: 2,
      purpose: "context-summary",
      inputIds: ["pending"],
      outcome: "success",
      usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 3 },
    });
    expect(records[0]).not.toHaveProperty("runId");
    expect(records[0]).not.toHaveProperty("step");
    expect(records[0].requestId).toBeTruthy();
    expect(result.requests).toEqual(records);
    expect(client.config.maxTokens).toBe(8192);
  });
});
