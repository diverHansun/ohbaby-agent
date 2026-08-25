import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactResult, ContextUsage } from "../../core/context/index.js";
import type {
  LLMClientInstance,
  StreamingResponse,
  TokenUsage,
} from "../../core/llm-client/index.js";

type StreamChatCompletion = (
  llmClient: LLMClientInstance,
  messages: readonly { readonly content: string; readonly role: string }[],
  options?: {
    readonly contextScopeId?: string;
    readonly purpose?: string;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
  },
) => AsyncIterable<StreamingResponse>;

const streamChatCompletionMock = vi.hoisted(() =>
  vi.fn<StreamChatCompletion>(),
);

vi.mock("../../core/llm-client/index.js", () => ({
  streamChatCompletion: streamChatCompletionMock,
}));

import {
  createContextSummaryClient,
  noticeFromCompactResult,
} from "./prompt-context.js";

function streamWithContent(
  content: string,
  tokenUsage?: TokenUsage,
): AsyncIterable<StreamingResponse> {
  return (async function* (): AsyncGenerator<StreamingResponse, void, unknown> {
    await Promise.resolve();
    yield {
      completeMessage: { content, role: "assistant" },
      isComplete: true,
      ...(tokenUsage === undefined
        ? {}
        : { tokenUsage: tokenUsage as StreamingResponse["tokenUsage"] }),
    };
  })();
}

function abortedStream(): AsyncIterable<StreamingResponse> {
  return (async function* (): AsyncGenerator<StreamingResponse, void, unknown> {
    await Promise.resolve();
    yield {
      completeMessage: { content: "", role: "assistant" },
      isComplete: true,
      streamStopReason: "user_aborted",
    };
  })();
}

function usage(currentTokens: number): ContextUsage {
  return {
    contextLimit: 128_000,
    currentTokens,
    modelId: "test-model",
    remainingTokens: 128_000 - currentTokens,
    usageRatio: currentTokens / 128_000,
  };
}

function compactResult(
  status: CompactResult["status"],
  input: Partial<CompactResult> = {},
): CompactResult {
  return {
    status,
    usageAfter: usage(20_000),
    usageBefore: usage(17_000),
    ...input,
  };
}

describe("createContextSummaryClient", () => {
  beforeEach(() => {
    streamChatCompletionMock.mockReset();
  });

  it("retries once when summary generation returns empty content", async () => {
    streamChatCompletionMock
      .mockReturnValueOnce(streamWithContent("  "))
      .mockReturnValueOnce(streamWithContent("valid summary"));
    const client = createContextSummaryClient({} as LLMClientInstance);

    await expect(
      client.generateSummary({
        history: [],
        prompt: "summarize",
        sessionId: "session_1",
        systemPrompt: "system",
      }),
    ).resolves.toBe("valid summary");
    expect(streamChatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it("accepts canonical auxiliary usage without coupling it to context accounting", async () => {
    streamChatCompletionMock.mockReturnValueOnce(
      streamWithContent("summary", {
        inputBreakdown: {
          cacheRead: 80,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 20,
        },
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      }),
    );
    const client = createContextSummaryClient({} as LLMClientInstance);

    await expect(
      client.generateSummary({
        history: [],
        prompt: "summarize",
        sessionId: "child_session",
        systemPrompt: "system",
      }),
    ).resolves.toBe("summary");
  });

  it("throws a clear error after repeated empty summaries", async () => {
    streamChatCompletionMock
      .mockReturnValueOnce(streamWithContent(""))
      .mockReturnValueOnce(streamWithContent("  "));
    const client = createContextSummaryClient({} as LLMClientInstance);

    await expect(
      client.generateSummary({
        history: [],
        prompt: "summarize",
        sessionId: "session_1",
        systemPrompt: "system",
      }),
    ).rejects.toThrow("empty after retries");
    expect(streamChatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it("forwards cancellation and does not retry an aborted summary stream", async () => {
    streamChatCompletionMock.mockReturnValueOnce(abortedStream());
    const client = createContextSummaryClient({} as LLMClientInstance);
    const controller = new AbortController();

    await expect(
      client.generateSummary({
        history: [],
        prompt: "summarize",
        sessionId: "session_1",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
    expect(streamChatCompletionMock.mock.calls[0]?.[2]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("does not start summary generation for an already aborted signal", async () => {
    const client = createContextSummaryClient({} as LLMClientInstance);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.generateSummary({
        history: [],
        prompt: "summarize",
        sessionId: "session_1",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it("sends both serialized history and the compression prompt to the model", async () => {
    streamChatCompletionMock.mockReturnValueOnce(streamWithContent("summary"));
    const client = createContextSummaryClient({} as LLMClientInstance);

    await client.generateSummary({
      contextScopeId: "subagent_1",
      history: [
        {
          info: {
            agent: "test",
            id: "message_1",
            role: "user",
            sessionId: "session_1",
            time: { created: 1 },
          },
          parts: [
            {
              id: "part_1",
              messageId: "message_1",
              orderIndex: 0,
              sessionId: "session_1",
              text: "hello",
              type: "text",
            },
            {
              id: "part_runtime",
              messageId: "message_1",
              metadata: { kind: "model-context:runtime:v1" },
              orderIndex: 1,
              sessionId: "session_1",
              synthetic: true,
              text: "<environment_context>private cwd</environment_context>",
              type: "text",
            },
          ],
        },
      ],
      prompt: "Use this exact format",
      sessionId: "session_1",
      systemPrompt: "system",
    });

    const messages = streamChatCompletionMock.mock.calls[0][1] as {
      readonly content: string;
      readonly role: string;
    }[];
    expect(messages).toEqual([
      { role: "system", content: "system" },
      {
        role: "user",
        content: expect.stringContaining("user: hello") as string,
      },
      {
        role: "user",
        content: expect.stringContaining("Use this exact format") as string,
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("private cwd");
    expect(streamChatCompletionMock.mock.calls[0][2]).toEqual({
      contextScopeId: "subagent_1",
      purpose: "context-summary",
      sessionId: "session_1",
    });
  });

  it("redacts credential canaries before and after summary generation", async () => {
    const canary = "json-summary-secret-canary";
    streamChatCompletionMock.mockReturnValueOnce(
      streamWithContent(
        `## Goal\n- keep ${JSON.stringify({ password: canary })}`,
      ),
    );
    const client = createContextSummaryClient({} as LLMClientInstance);

    const summary = await client.generateSummary({
      history: [
        {
          info: {
            agent: "test",
            id: "message_1",
            role: "user",
            sessionId: "session_1",
            time: { created: 1 },
          },
          parts: [
            {
              id: "part_1",
              messageId: "message_1",
              orderIndex: 0,
              sessionId: "session_1",
              text: `Do not expose ${JSON.stringify({ apiKey: canary })}`,
              type: "text",
            },
          ],
        },
      ],
      prompt: "Use this exact format",
      sessionId: "session_1",
      systemPrompt: "system",
    });

    expect(
      JSON.stringify(streamChatCompletionMock.mock.calls[0]?.[1]),
    ).not.toContain(canary);
    expect(summary).not.toContain(canary);
    expect(summary).toContain("[redacted]");
  });
});

describe("noticeFromCompactResult", () => {
  it("does not emit notices for successful compact results", () => {
    expect(
      noticeFromCompactResult("session_1", compactResult("compacted")),
    ).toBeUndefined();
    expect(
      noticeFromCompactResult("session_1", compactResult("pruned")),
    ).toBeUndefined();
  });

  it("emits compact warnings without token deltas for failed and inflated results", () => {
    const failedNotice = noticeFromCompactResult(
      "session_1",
      compactResult("failed", { error: "summary generation failed" }),
    );
    const inflatedNotice = noticeFromCompactResult(
      "session_1",
      compactResult("inflated"),
    );

    expect(failedNotice).toMatchObject({
      key: "context:compact:session_1",
      level: "warning",
      title: "Context compact warning",
    });
    expect(inflatedNotice).toMatchObject({
      key: "context:compact:session_1",
      level: "warning",
      title: "Context compact warning",
    });
    expect(failedNotice?.message).not.toContain("->");
    expect(inflatedNotice?.message).not.toContain("->");
    expect(failedNotice?.message).not.toMatch(/\d[\d,]*\s*tokens/u);
    expect(inflatedNotice?.message).not.toMatch(/\d[\d,]*\s*tokens/u);
  });
});
