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
      backgroundColor: theme.message.userBlockBg,
      color: theme.role.user,
      gutterColor: theme.message.userGutter,
      kind: "text",
      text: "please inspect the repo",
    });
  });

  it("renders transient reasoning as dim text before assistant content", () => {
    const theme = createTheme("dark", 3);
    const message = assistantMessage([
      { text: "visible answer", type: "text" },
    ]);

    expect(
      renderMessageParts(message, 80, theme, {
        content: "thinking through it",
        folded: false,
      })[0],
    ).toMatchObject({
      color: theme.reasoning,
      dimColor: true,
      kind: "text",
      text: "thinking through it",
    });

    expect(
      renderMessageParts(message, 80, theme, {
        content: "thinking through it",
        folded: true,
      })[0],
    ).toMatchObject({
      color: theme.reasoning,
      dimColor: true,
      kind: "text",
      text: "Thought",
    });
  });

  it("aligns wrapped historical user message lines under the muted gutter", () => {
    const message = userMessage([
      { text: "please inspect the repository now", type: "text" },
    ]);

    const app = render(<MessageRow contentWidth={16} message={message} />);
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("| please");
    expect(frame).toContain("  the repository");
  });

  it("marks a length-truncated assistant message in the rendered output", () => {
    const message: UiMessage = {
      ...assistantMessage([{ text: "partial answer", type: "text" }]),
      finishReason: "length",
      status: "completed",
    };

    const app = render(<MessageRow contentWidth={80} message={message} />);
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("partial answer");
    expect(frame).toContain("output truncated");
  });

  it("does not mark assistant messages that finished normally", () => {
    const message: UiMessage = {
      ...assistantMessage([{ text: "complete answer", type: "text" }]),
      finishReason: "stop",
      status: "completed",
    };

    const app = render(<MessageRow contentWidth={80} message={message} />);

    expect(app.lastFrame()).not.toContain("output truncated");
  });

  it("does not mark a still-streaming assistant message", () => {
    const message: UiMessage = {
      ...assistantMessage([{ text: "streaming answer", type: "text" }]),
      status: "streaming",
    };

    const app = render(<MessageRow contentWidth={80} message={message} />);

    expect(app.lastFrame()).not.toContain("output truncated");
  });

  it("renders a paired completed tool call as one tool line", () => {
    const theme = createTheme("dark", 3);
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

    const rendered = renderMessageParts(message, 80, theme);
    expect(rendered[0]).toMatchObject({
      kind: "text",
      segments: [
        { color: theme.tool.name, text: "Bash" },
        { color: theme.tool.arg, text: " pnpm test" },
      ],
    });

    const app = render(<MessageRow contentWidth={80} message={message} />);

    expect(app.lastFrame()).toContain("Bash pnpm test");
  });

  it("keeps tool name and argument colors when a completed tool line wraps", () => {
    const theme = createTheme("dark", 3);
    const message = assistantMessage([
      {
        call: {
          ...toolCall("call_1"),
          input: {
            command: "pnpm test --filter packages/ohbaby-cli --runInBand",
          },
          status: "completed",
        },
        type: "tool-call",
      },
      {
        result: { callId: "call_1", output: "ok" },
        type: "tool-result",
      },
    ]);

    const rendered = renderMessageParts(message, 24, theme);

    const first = rendered[0];
    expect(first.kind).toBe("text");
    if (first.kind !== "text" || !first.segments) {
      throw new Error("Expected wrapped tool label segments");
    }
    expect(first.segments[0]).toEqual({ color: theme.tool.name, text: "Bash" });
    expect(first.segments[1]?.color).toBe(theme.tool.arg);
    expect(first.segments[1]?.text).toContain("\n");
  });

  it("keeps failed suffix color when a tool error wraps", () => {
    const theme = createTheme("dark", 3);
    const message = assistantMessage([
      {
        call: {
          ...toolCall("call_1"),
          input: { command: "pnpm test" },
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_1",
          error:
            "Permission denied because the requested command touches protected files",
          output: "",
        },
        type: "tool-result",
      },
    ]);

    const rendered = renderMessageParts(message, 26, theme);

    const first = rendered[0];
    expect(first.kind).toBe("text");
    if (first.kind !== "text" || !first.segments) {
      throw new Error("Expected wrapped failed tool label segments");
    }
    const failedText = first.segments
      .filter((segment) => segment.color === theme.tool.failed)
      .map((segment) => segment.text)
      .join("");
    expect(failedText).toContain("\n");
    expect(failedText).toContain("Permission denied");
  });

  it("keeps completed tool rows aligned with the running spinner prefix", () => {
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
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("  Bash pnpm test");
    expect(frame).not.toContain("✓");
    expect(frame).not.toContain("✗");
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

  it("keeps running tool label colors stable outside the spinner frame", () => {
    const theme = createTheme("dark", 3);
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

    const rendered = renderMessageParts(message, 80, theme);

    expect(rendered[0]).toMatchObject({
      kind: "spinner",
      segments: [
        { color: theme.tool.name, text: "Bash" },
        { color: theme.tool.arg, text: " pnpm test" },
      ],
    });
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
