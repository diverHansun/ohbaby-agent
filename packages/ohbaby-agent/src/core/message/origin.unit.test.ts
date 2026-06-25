import { describe, expect, it } from "vitest";
import type { MessageWithParts } from "./types.js";
import { getMessageOrigin, isContextSummaryPart } from "./origin.js";

function message(input: {
  readonly id: string;
  readonly role: MessageWithParts["info"]["role"];
  readonly parts?: MessageWithParts["parts"];
}): MessageWithParts {
  const base = {
    id: input.id,
    sessionId: "session_1",
    time: { created: 1 },
  } as const;
  const info =
    input.role === "assistant"
      ? { ...base, agent: "default", role: "assistant" as const }
      : input.role === "system"
        ? { ...base, kind: "info" as const, role: "system" as const }
        : { ...base, agent: "default", role: "user" as const };
  return { info, parts: input.parts ?? [] };
}

describe("message origin", () => {
  it("derives summary from the existing context-summary metadata", () => {
    const summaryPart = {
      id: "part_summary",
      messageId: "message_summary",
      metadata: { kind: "context-summary" },
      orderIndex: 0,
      sessionId: "session_1",
      text: "compressed history",
      type: "text",
    } as const;

    expect(isContextSummaryPart(summaryPart)).toBe(true);
    expect(
      getMessageOrigin(
        message({
          id: "message_summary",
          parts: [summaryPart],
          role: "assistant",
        }),
      ),
    ).toBe("summary");
  });

  it("derives tool origin before assistant fallback", () => {
    expect(
      getMessageOrigin(
        message({
          id: "message_tool",
          parts: [
            {
              callId: "call_1",
              id: "part_tool",
              messageId: "message_tool",
              orderIndex: 0,
              sessionId: "session_1",
              state: {
                input: {},
                output: "done",
                status: "completed",
              },
              tool: "read_file",
              type: "tool",
            },
          ],
          role: "assistant",
        }),
      ),
    ).toBe("tool");
  });

  it("falls back to existing message roles", () => {
    expect(getMessageOrigin(message({ id: "message_user", role: "user" }))).toBe(
      "user",
    );
    expect(
      getMessageOrigin(message({ id: "message_assistant", role: "assistant" })),
    ).toBe("assistant");
    expect(
      getMessageOrigin(message({ id: "message_system", role: "system" })),
    ).toBe("system");
  });
});
