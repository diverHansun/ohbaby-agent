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
      />,
    );

    app.rerender(
      <TranscriptViewport
        commandNotices={[]}
        committedMessages={[message("alpha", "Alpha prompt")]}
        liveMessage={null}
        notices={[]}
      />,
    );

    expect(app.lastFrame()).toContain("Alpha prompt");
    expect(app.lastFrame()).not.toContain("Beta prompt");
  });
});

function message(id: string, text: string): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:00.000Z",
    id,
    parts: [{ text, type: "text" }],
    role: "assistant",
  };
}
