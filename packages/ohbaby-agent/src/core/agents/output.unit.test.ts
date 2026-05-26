import { describe, expect, it } from "vitest";
import { extractFinalOutput } from "./output.js";
import type { MessageWithParts, Part } from "../message/index.js";

function part(input: {
  readonly messageId: string;
  readonly orderIndex: number;
  readonly text: string;
  readonly type?: "text" | "reasoning";
}): Part {
  return {
    id: `part_${input.messageId}_${String(input.orderIndex)}`,
    messageId: input.messageId,
    orderIndex: input.orderIndex,
    sessionId: "session_1",
    text: input.text,
    type: input.type ?? "text",
  };
}

function message(input: {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly parts?: readonly Part[];
}): MessageWithParts {
  return {
    info: {
      id: input.id,
      agent: "build",
      role: input.role,
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: input.parts ?? [],
  };
}

describe("extractFinalOutput", () => {
  it("returns an empty string for empty history", () => {
    expect(extractFinalOutput([])).toBe("");
  });

  it("returns the latest non-empty assistant text before trailing user messages", () => {
    const output = extractFinalOutput([
      message({
        id: "assistant_1",
        role: "assistant",
        parts: [part({ messageId: "assistant_1", orderIndex: 0, text: "old" })],
      }),
      message({ id: "user_1", role: "user" }),
      message({
        id: "assistant_2",
        role: "assistant",
        parts: [
          part({
            messageId: "assistant_2",
            orderIndex: 0,
            text: "reason ",
            type: "reasoning",
          }),
          part({ messageId: "assistant_2", orderIndex: 1, text: "answer" }),
        ],
      }),
      message({ id: "user_2", role: "user" }),
    ]);

    expect(output).toBe("reason answer");
  });

  it("skips blank assistant messages when searching backward", () => {
    const output = extractFinalOutput([
      message({
        id: "assistant_1",
        role: "assistant",
        parts: [part({ messageId: "assistant_1", orderIndex: 0, text: "done" })],
      }),
      message({
        id: "assistant_2",
        role: "assistant",
        parts: [part({ messageId: "assistant_2", orderIndex: 0, text: "   " })],
      }),
    ]);

    expect(output).toBe("done");
  });
});
