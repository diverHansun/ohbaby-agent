import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { UiMessage, UiMessagePart, UiToolCall } from "ohbaby-sdk";
import {
  MessageRow,
  pairToolCallResult,
  renderMessageParts,
} from "./message-row.js";
import { createTheme } from "../../theme/index.js";

describe("pairToolCallResult", () => {
  it("pairs a tool call with the immediately following matching result", () => {
    const call = toolCall("call_1");
    const result = {
      result: { callId: "call_1", output: "ok" },
      type: "tool-result" as const,
    };

    const paired = pairToolCallResult([
      { text: "before", type: "text" },
      { call, type: "tool-call" },
      result,
      { text: "after", type: "text" },
    ]);

    expect(paired).toHaveLength(3);
    expect(paired[0]).toMatchObject({ kind: "part", index: 0 });
    expect(paired[1]).toMatchObject({
      call,
      index: 1,
      kind: "tool",
      result: result.result,
    });
    expect(paired[2]).toMatchObject({ kind: "part", index: 3 });
  });

  it("does not pair a tool call with an unrelated result", () => {
    const paired = pairToolCallResult([
      { call: toolCall("call_1"), type: "tool-call" },
      {
        result: { callId: "call_2", output: "other" },
        type: "tool-result",
      },
    ]);

    expect(paired.map((part) => part.kind)).toEqual(["tool", "part"]);
    expect(paired[0]).toMatchObject({ kind: "tool", result: undefined });
  });

  it("pairs tool calls with later matching results", () => {
    const call1 = toolCall("call_1");
    const call2 = toolCall("call_2");
    const result1 = {
      result: { callId: "call_1", output: "first" },
      type: "tool-result" as const,
    };
    const result2 = {
      result: { callId: "call_2", output: "second" },
      type: "tool-result" as const,
    };

    const paired = pairToolCallResult([
      { call: call1, type: "tool-call" },
      { call: call2, type: "tool-call" },
      result1,
      result2,
    ]);

    expect(paired).toEqual([
      { call: call1, index: 0, kind: "tool", result: result1.result },
      { call: call2, index: 1, kind: "tool", result: result2.result },
    ]);
  });
});

describe("MessageRow", () => {
  it("keeps historical user message text readable while muting only the gutter", () => {
    const theme = createTheme("dark", 3);
    const message = userMessage([
      { text: "please inspect the repo", type: "text" },
    ]);

    const rendered = renderMessageParts(message, 80, theme);

    expect(rendered[0]).toMatchObject({
      color: theme.role.user,
      gutterColor: theme.message.userGutter,
      kind: "text",
      text: "please inspect the repo",
    });
  });

  it("renders a paired completed tool call as one tool line", () => {
    const message = assistantMessage([
      {
        call: {
          ...toolCall("call_1"),
          input: { command: "pnpm test" },
          status: "completed",
        },
        type: "tool-call",
      },
      {
        result: { callId: "call_1", output: "ok" },
        type: "tool-result",
      },
    ]);

    const app = render(<MessageRow contentWidth={80} message={message} />);

    expect(app.lastFrame()).toContain("Bash pnpm test");
  });

  it("renders an unpaired running tool call with the live spinner", () => {
    const previousNoAnimation = process.env.OHBABY_TUI_NO_ANIM;
    process.env.OHBABY_TUI_NO_ANIM = "1";
    const message = assistantMessage([
      {
        call: {
          ...toolCall("call_1"),
          input: { command: "pnpm test" },
          status: "running",
        },
        type: "tool-call",
      },
    ]);

    const app = render(<MessageRow contentWidth={80} message={message} />);

    try {
      expect(app.lastFrame()).toContain("⠋ Bash pnpm test");
    } finally {
      app.unmount();
      if (previousNoAnimation === undefined) {
        delete process.env.OHBABY_TUI_NO_ANIM;
      } else {
        process.env.OHBABY_TUI_NO_ANIM = previousNoAnimation;
      }
    }
  });
});

function assistantMessage(parts: readonly UiMessagePart[]): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:00.000Z",
    id: "message_1",
    parts,
    role: "assistant",
  };
}

function userMessage(parts: readonly UiMessagePart[]): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:00.000Z",
    id: "message_user",
    parts,
    role: "user",
  };
}

function toolCall(id: string): UiToolCall {
  return {
    id,
    input: {},
    name: "bash",
    status: "running",
  };
}
