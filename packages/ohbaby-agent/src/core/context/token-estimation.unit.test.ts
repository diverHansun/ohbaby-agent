import { describe, expect, it } from "vitest";
import type { PreparedModelRequest, TokenCounter } from "./types.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";

function characterCounter(): Pick<TokenCounter, "estimateTokens"> {
  return {
    estimateTokens: (content: string): number => content.length,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

describe("estimatePreparedRequestHeuristic", () => {
  it("counts the complete message projection without mutating the request", () => {
    const request = deepFreeze({
      messages: [
        { role: "system" as const, content: "system prompt" },
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "answer" },
      ],
      tools: undefined,
    } satisfies PreparedModelRequest);
    const before = structuredClone(request);

    expect(estimatePreparedRequestHeuristic(request, characterCounter())).toBe(
      request.messages.map((message) => JSON.stringify(message)).join("\n")
        .length,
    );
    expect(request).toEqual(before);
  });

  it("counts non-empty tool schemas in their request order", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const tools = [
      {
        function: {
          description: "Read a file",
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
      {
        function: {
          description: "List files",
          name: "list_files",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];
    const counter = characterCounter();
    const messagesOnly = estimatePreparedRequestHeuristic(
      { messages, tools: undefined },
      counter,
    );

    expect(
      estimatePreparedRequestHeuristic({ messages, tools: [] }, counter),
    ).toBe(messagesOnly);
    expect(estimatePreparedRequestHeuristic({ messages, tools }, counter)).toBe(
      messagesOnly + 1 + JSON.stringify(tools).length,
    );
  });

  it("counts assistant tool calls when message content is null", () => {
    const request = {
      messages: [
        {
          content: null,
          role: "assistant" as const,
          tool_calls: [
            {
              function: {
                arguments: '{"path":"/a/very/long/path.ts"}',
                name: "read_file",
              },
              id: "call_read",
              type: "function" as const,
            },
          ],
        },
      ],
      tools: undefined,
    } satisfies PreparedModelRequest;

    expect(estimatePreparedRequestHeuristic(request, characterCounter())).toBe(
      JSON.stringify(request.messages[0]).length,
    );
  });
});
