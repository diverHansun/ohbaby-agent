import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactResult, ContextUsage } from "../../core/context/index.js";
import type { MessageWithParts } from "../../core/message/types.js";
import type {
  LLMClientInstance,
  StreamingResponse,
  TokenUsage,
} from "../../core/llm-client/index.js";

type StreamResponseFn = (
  llmClient: LLMClientInstance,
  messages: readonly { readonly content: string; readonly role: string }[],
  options?: {
    readonly contextScopeId?: string;
    readonly purpose?: string;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
  },
) => AsyncIterable<StreamingResponse>;

const streamResponseMock = vi.hoisted(() => vi.fn<StreamResponseFn>());

vi.mock("../../core/llm-client/index.js", () => ({
  streamResponse: streamResponseMock,
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
      messageSnapshot: { content },
      isComplete: true,
      finishReason: "stop",
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    };
  })();
}

function abortedStream(): AsyncIterable<StreamingResponse> {
  return (async function* (): AsyncGenerator<StreamingResponse, void, unknown> {
    await Promise.resolve();
    yield {
      messageSnapshot: { content: "" },
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
    streamResponseMock.mockReset();
  });

  it("retries once when summary generation returns empty content", async () => {
    streamResponseMock
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
    expect(streamResponseMock).toHaveBeenCalledTimes(2);
  });

  it("sends permitted failure facts to the actual summary request without cancelled or unknown text", async () => {
    streamResponseMock.mockReturnValueOnce(streamWithContent("summary"));
    const client = createContextSummaryClient({} as LLMClientInstance);
    const history: MessageWithParts[] = [
      {
        info: {
          id: "limited",
          sessionId: "session_1",
          agent: "test",
          role: "assistant",
          time: { created: 1, completed: 2 },
          finish: "error",
          error: { name: "MessageOutputLengthError" },
        },
        parts: [
          {
            id: "body",
            messageId: "limited",
            sessionId: "session_1",
            orderIndex: 0,
            type: "text",
            text: "saved limited answer",
          },
        ],
      },
      {
        info: {
          id: "cancelled",
          sessionId: "session_1",
          agent: "test",
          role: "assistant",
          time: { created: 3, completed: 4 },
          finish: "error",
          error: { name: "MessageAbortedError", message: "cancelled" },
        },
        parts: [
          {
            id: "cancelled_body",
            messageId: "cancelled",
            sessionId: "session_1",
            orderIndex: 0,
            type: "text",
            text: "must not enter summary",
          },
          {
            id: "fact",
            messageId: "cancelled",
            sessionId: "session_1",
            orderIndex: 1,
            type: "text",
            text: "[Response cancelled by the user.]",
            synthetic: true,
            metadata: { kind: "lifecycle-interruption" },
          },
        ],
      },
      {
        info: {
          id: "unknown",
          sessionId: "session_1",
          agent: "test",
          role: "assistant",
          time: { created: 5, completed: 6 },
          finish: "error",
          error: { name: "Unknown", message: "transport interrupted" },
        },
        parts: [
          {
            id: "unknown_body",
            messageId: "unknown",
            sessionId: "session_1",
            orderIndex: 0,
            type: "text",
            text: "unknown failure body",
          },
        ],
      },
    ];

    await expect(
      client.generateSummary({
        history,
        prompt: "summarize",
        sessionId: "session_1",
      }),
    ).resolves.toBe("summary");
    expect(streamResponseMock.mock.calls[0]?.[1][1]).toEqual({
      role: "user",
      content:
        "assistant: [Response incomplete: output limit reached.]\nsaved limited answer\n\nassistant: [Response cancelled by the user.]",
    });
  });

  it("accepts canonical auxiliary usage without coupling it to context accounting", async () => {
    streamResponseMock.mockReturnValueOnce(
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
    streamResponseMock
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
    expect(streamResponseMock).toHaveBeenCalledTimes(2);
  });

  it("forwards cancellation and does not retry an aborted summary stream", async () => {
    streamResponseMock.mockReturnValueOnce(abortedStream());
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
    expect(streamResponseMock).toHaveBeenCalledTimes(1);
    expect(streamResponseMock.mock.calls[0]?.[2]).toMatchObject({
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
    expect(streamResponseMock).not.toHaveBeenCalled();
  });

  it("sends both serialized history and the compression prompt to the model", async () => {
    streamResponseMock.mockReturnValueOnce(streamWithContent("summary"));
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

    const messages = streamResponseMock.mock.calls[0][1] as {
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
    expect(streamResponseMock.mock.calls[0][2]).toEqual({
      contextScopeId: "subagent_1",
      purpose: "context-summary",
      sessionId: "session_1",
    });
  });

  it("sends summary-only tool facts through the production summary request", async () => {
    streamResponseMock.mockReturnValueOnce(streamWithContent("summary"));
    const client = createContextSummaryClient({} as LLMClientInstance);
    await client.generateSummary({
      sessionId: "s",
      prompt: "summarize",
      history: [
        {
          info: {
            id: "m",
            role: "assistant",
            agent: "test",
            sessionId: "s",
            time: { created: 1 },
          },
          parts: [
            {
              id: "p",
              messageId: "m",
              sessionId: "s",
              orderIndex: 0,
              type: "tool",
              tool: "bash",
              callId: "c",
              state: {
                status: "completed",
                input: { command: "pwd", apiKey: "summary-input-canary" },
                output: "",
                metadata: { exitCode: 0, internalSecret: "private-metadata" },
              },
            },
          ],
        },
      ],
    });
    const sent = streamResponseMock.mock.calls[0][1][1].content;
    expect(sent).toContain('"tool":"bash"');
    expect(sent).toContain('"command":"pwd"');
    expect(sent).toContain('"status":"completed"');
    expect(sent).toContain('"exitCode":0');
    expect(sent).not.toContain("summary-input-canary");
    expect(sent).not.toContain("private-metadata");
  });

  it("redacts credential canaries before and after summary generation", async () => {
    const canary = "json-summary-secret-canary";
    streamResponseMock.mockReturnValueOnce(
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

    expect(JSON.stringify(streamResponseMock.mock.calls[0]?.[1])).not.toContain(
      canary,
    );
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
