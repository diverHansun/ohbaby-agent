import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import { MessageList } from "./message-list.js";

describe("MessageList", () => {
  it("keeps committed messages visible while the live last message changes", () => {
    const first = message("message_1", "first committed");
    const app = render(
      <MessageList
        commandNotices={[]}
        messages={[first, message("message_2", "live draft")]}
        notices={[]}
      />,
    );

    app.rerender(
      <MessageList
        commandNotices={[]}
        messages={[first, message("message_2", "live updated")]}
        notices={[]}
      />,
    );

    expect(app.lastFrame()).toContain("first committed");
    expect(app.lastFrame()).toContain("live updated");
  });

  it("does not retain committed messages from a replaced transcript", () => {
    const app = render(
      <MessageList
        commandNotices={[]}
        messages={[
          message("beta_user", "Beta prompt"),
          message("beta_assistant", "Beta reply"),
        ]}
        notices={[]}
      />,
    );

    app.rerender(
      <MessageList
        commandNotices={[]}
        messages={[
          message("alpha_user", "Alpha prompt"),
          message("alpha_assistant", "Alpha reply"),
        ]}
        notices={[]}
      />,
    );

    expect(app.lastFrame()).toContain("Alpha prompt");
    expect(app.lastFrame()).toContain("Alpha reply");
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
