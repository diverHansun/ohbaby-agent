import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import { TranscriptViewport } from "./transcript-viewport.js";

describe("TranscriptViewport", () => {
  it("renders committed messages, command notices, live tail, and UI notices in order", () => {
    const committed = message("message_committed", "committed answer");
    const live = message("message_live", "live answer");
    const app = render(
      <TranscriptViewport
        commandNotices={[
          {
            commandId: "command_status",
            id: "command_notice_1",
            kind: "result",
            text: "command output",
          },
        ]}
        committedMessages={[committed]}
        liveMessage={live}
        notices={[
          {
            createdAt: "2026-06-07T00:00:00.000Z",
            id: "notice_1",
            level: "warning",
            message: "Context could not refresh",
            title: "Context unavailable",
          },
        ]}
        runtime={{ kind: "idle" }}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame.indexOf("committed answer")).toBeLessThan(
      frame.indexOf("command output"),
    );
    expect(frame.indexOf("command output")).toBeLessThan(
      frame.indexOf("live answer"),
    );
    expect(frame.indexOf("live answer")).toBeLessThan(
      frame.indexOf("Context unavailable"),
    );
  });

  it("does not retain committed messages from a replaced transcript", () => {
    const app = render(
      <TranscriptViewport
        commandNotices={[]}
        committedMessages={[message("beta", "Beta prompt")]}
        liveMessage={null}
        notices={[]}
        runtime={{ kind: "idle" }}
      />,
    );

    app.rerender(
      <TranscriptViewport
        commandNotices={[]}
        committedMessages={[message("alpha", "Alpha prompt")]}
        liveMessage={null}
        notices={[]}
        runtime={{ kind: "idle" }}
      />,
    );

    expect(app.lastFrame()).toContain("Alpha prompt");
    expect(app.lastFrame()).not.toContain("Beta prompt");
  });

  it("renders the complete committed transcript so terminal scrollback owns overflow", () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(`message_${String(index)}`, `committed ${String(index)}`),
    );
    const app = render(
      <TranscriptViewport
        commandNotices={[]}
        committedMessages={messages}
        liveMessage={null}
        notices={[]}
        runtime={{ kind: "idle" }}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("committed 0");
    expect(frame).toContain("committed 19");
    expect(frame).not.toContain("lines below");
  });

  it("keeps visible spacing between a submitted user prompt and the assistant reply", () => {
    const app = render(
      <TranscriptViewport
        commandNotices={[]}
        committedMessages={[
          message("user_message", "try the read tool", "user"),
        ]}
        liveMessage={message("assistant_message", "read succeeded")}
        notices={[]}
        runtime={{ kind: "idle" }}
      />,
    );

    expect(app.lastFrame()).toMatch(
      /try the read tool[\s\S]*\n\s*\nread succeeded/,
    );
  });
});

function message(
  id: string,
  text: string,
  role: UiMessage["role"] = "assistant",
): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:00.000Z",
    id,
    parts: [{ text, type: "text" }],
    role,
  };
}
