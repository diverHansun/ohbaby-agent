import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LLMClientInstance,
  StreamingResponse,
} from "../../core/llm-client/index.js";

type StreamChatCompletion = (
  llmClient: LLMClientInstance,
  messages: readonly { readonly content: string; readonly role: string }[],
) => AsyncIterable<StreamingResponse>;

const streamChatCompletionMock = vi.hoisted(() =>
  vi.fn<StreamChatCompletion>(),
);

vi.mock("../../core/llm-client/index.js", () => ({
  streamChatCompletion: streamChatCompletionMock,
}));

import { createContextSummaryClient } from "./prompt-context.js";

function streamWithContent(content: string): AsyncIterable<StreamingResponse> {
  return (async function* (): AsyncGenerator<StreamingResponse, void, unknown> {
    await Promise.resolve();
    yield {
      completeMessage: { content, role: "assistant" },
      isComplete: true,
    };
  })();
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

  it("sends both serialized history and the compression prompt to the model", async () => {
    streamChatCompletionMock.mockReturnValueOnce(streamWithContent("summary"));
    const client = createContextSummaryClient({} as LLMClientInstance);

    await client.generateSummary({
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
  });
});
