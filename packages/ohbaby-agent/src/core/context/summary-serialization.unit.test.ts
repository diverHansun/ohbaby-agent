import { expect, it } from "vitest";
import type { MessageWithParts, ToolPart } from "../message/index.js";
import { serializeHistory } from "./serialization.js";
import { estimateHistoryForCompaction } from "./compaction-policy.js";

function history(tool: string, state: ToolPart["state"]): MessageWithParts[] {
  return [
    {
      info: {
        id: "m",
        role: "assistant",
        agent: "test",
        sessionId: "s",
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          type: "tool",
          id: "p",
          messageId: "m",
          sessionId: "s",
          orderIndex: 0,
          callId: "c",
          tool,
          state,
        },
      ],
    },
  ];
}

it("keeps distinct empty-output tool actions in summary material without changing history scoring", () => {
  const read = history("read", {
    status: "completed",
    input: { filePath: "a.txt" },
    output: "",
  });
  const bash = history("bash", {
    status: "completed",
    input: { command: "pwd" },
    output: "",
    metadata: { exitCode: 0, privateDetail: "internal-only" },
  });
  const options = { includeModelContext: false, includeToolContext: true };
  const readSummary = serializeHistory(read, options);
  const bashSummary = serializeHistory(bash, options);
  expect(readSummary).not.toBe(bashSummary);
  expect(readSummary).toContain("read");
  expect(readSummary).toContain("a.txt");
  expect(bashSummary).toContain("pwd");
  expect(bashSummary).toContain("completed");
  expect(bashSummary).toContain("exitCode");
  expect(bashSummary).not.toContain("internal-only");
  expect(serializeHistory(read)).toBe("assistant");
  expect(serializeHistory(bash)).toBe("assistant");
  expect(
    estimateHistoryForCompaction(read, {
      estimateTokens: (text) => text.length,
    }),
  ).toBe(9);
  expect(
    estimateHistoryForCompaction(bash, {
      estimateTokens: (text) => text.length,
    }),
  ).toBe(9);
});

it("preserves aborted partial results and clearly marks the action incomplete", () => {
  const input = history("bash", {
    status: "aborted",
    input: { command: "task" },
    output: "partial progress",
    error: "Tool execution aborted by user",
  });
  const summary = serializeHistory(input, {
    includeModelContext: false,
    includeToolContext: true,
  });
  expect(summary).toContain("aborted");
  expect(summary).toContain("partial progress");
  expect(summary).toContain("Tool execution aborted by user");
  expect(summary).toContain("task");
  expect(serializeHistory(input)).toBe(
    "assistant: Tool execution aborted by user",
  );
});
