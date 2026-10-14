import { expect, it } from "vitest";
import type { MessageWithParts, ToolPart } from "../message/index.js";
import { serializeHistory } from "./serialization.js";
import {
  estimateHistoryForCompaction,
  findCutPoint,
} from "./compaction-policy.js";
import { serializeHistoryMessages } from "./serializer.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";

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

it("counts tool actions and metadata in the same projection sent to the model", () => {
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
  const counter = { estimateTokens: (text: string): number => text.length };
  for (const sample of [read, bash]) {
    const messages = serializeHistoryMessages(sample);
    expect(estimateHistoryForCompaction(sample, counter)).toBe(
      estimatePreparedRequestHeuristic({ messages, tools: undefined }, counter),
    );
  }
  expect(estimateHistoryForCompaction(bash, counter)).toBeGreaterThan(9);
});

it("counts compatible in-memory reasoning but not display-only reasoning", () => {
  const sample = history("read", {
    status: "completed",
    input: { filePath: "a.txt" },
    output: "result",
  });
  const reasoning = new Map([["m", "reasoning ".repeat(500)]]);
  const counter = { estimateTokens: (text: string): number => text.length };
  const messages = serializeHistoryMessages(sample, reasoning);
  const expected = estimatePreparedRequestHeuristic(
    { messages, tools: undefined },
    counter,
  );
  expect(
    estimateHistoryForCompaction(sample, counter, undefined, reasoning),
  ).toBe(expected);
  expect(expected).toBeGreaterThan(
    estimateHistoryForCompaction(sample, counter) + 4000,
  );
  sample[0] = {
    ...sample[0],
    parts: [
      ...sample[0].parts,
      {
        type: "reasoning",
        text: "display only ".repeat(1000),
        id: "display",
        messageId: "m",
        sessionId: "s",
        orderIndex: 1,
      },
    ],
  };
  expect(
    estimateHistoryForCompaction(sample, counter, undefined, reasoning),
  ).toBe(expected);
});

it("uses active reasoning when accumulating individual tail messages", () => {
  const tool = history("read", {
    status: "completed",
    input: {},
    output: "result",
  });
  const textMessage = (id: string, text: string): MessageWithParts => ({
    info: {
      id,
      role: "user",
      agent: "test",
      sessionId: "s",
      time: { created: 1 },
    },
    parts: [
      {
        type: "text",
        id: `${id}-part`,
        messageId: id,
        sessionId: "s",
        orderIndex: 0,
        text,
      },
    ],
  });
  const input = {
    history: [
      textMessage("old", "x".repeat(10_000)),
      ...tool,
      textMessage("latest", "continue"),
    ],
    keepRecentTokens: 1000,
    tokenCounter: { estimateTokens: (text: string): number => text.length },
  };
  expect(findCutPoint(input).firstKeptIndex).toBe(1);
  expect(
    findCutPoint({
      ...input,
      activeReasoningByMessageId: new Map([["m", "r".repeat(2000)]]),
    }).firstKeptIndex,
  ).toBe(2);
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
