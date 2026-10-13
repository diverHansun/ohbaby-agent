import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompactResult,
  ContextLLMClient,
  ContextUsage,
} from "../../core/context/index.js";
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

function summaryInput(
  signal?: AbortSignal,
): Parameters<ContextLLMClient["generateSummary"]>[0] {
  return {
    request: {
      messages: [
        { role: "system" as const, content: "original system" },
        { role: "user" as const, content: "history" },
        { role: "user" as const, content: "summarize" },
      ],
      tools: [{ name: "read", inputSchema: {} }],
      settings: { model: "test-model", maxTokens: 16384 },
    },
    sessionId: "s",
    summaryMessageId: "summary",
    compactionId: "compact",
    attempt: 1,
    signal,
  };
}

describe("createContextSummaryClient", () => {
  beforeEach(() => streamResponseMock.mockReset());
  it("rejects empty content without spending another request", async () => {
    streamResponseMock.mockReturnValueOnce(streamWithContent("  "));
    await expect(
      createContextSummaryClient({} as LLMClientInstance).generateSummary(
        summaryInput(),
      ),
    ).rejects.toThrow("empty");
    expect(streamResponseMock).toHaveBeenCalledTimes(1);
  });
  it("sends prepared messages unchanged and disables lower-layer retries", async () => {
    streamResponseMock.mockReturnValueOnce(streamWithContent("summary"));
    const input = summaryInput();
    await expect(
      createContextSummaryClient({} as LLMClientInstance).generateSummary(
        input,
      ),
    ).resolves.toMatchObject({ text: "summary", summaryMessageId: "summary" });
    expect(streamResponseMock.mock.calls[0][1]).toBe(input.request.messages);
    expect(streamResponseMock.mock.calls[0][2]).toMatchObject({
      purpose: "context-summary",
      tools: input.request.tools,
      maxTokens: 16384,
      retry: { maxRetriesPerStep: 0 },
    });
  });
  it("forwards cancellation without retry", async () => {
    streamResponseMock.mockReturnValueOnce(abortedStream());
    const controller = new AbortController();
    await expect(
      createContextSummaryClient({} as LLMClientInstance).generateSummary(
        summaryInput(controller.signal),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamResponseMock).toHaveBeenCalledTimes(1);
    expect(streamResponseMock.mock.calls[0][2]).toMatchObject({
      signal: controller.signal,
    });
  });
  it("does not start an already aborted summary", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createContextSummaryClient({} as LLMClientInstance).generateSummary(
        summaryInput(controller.signal),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamResponseMock).not.toHaveBeenCalled();
  });
  it("redacts credentials from generated summary text", async () => {
    streamResponseMock.mockReturnValueOnce(
      streamWithContent('summary {"password":"summary-secret-canary"}'),
    );
    const result = await createContextSummaryClient(
      {} as LLMClientInstance,
    ).generateSummary(summaryInput());
    expect(result.text).not.toContain("summary-secret-canary");
    expect(result.text).toContain("[redacted]");
  });
});

describe("noticeFromCompactResult", () => {
  it("does not emit notices for successful compact results", () => {
    expect(
      noticeFromCompactResult("session_1", compactResult("compacted")),
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
