import { render } from "ink-testing-library";
import type { UiMessage } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
  CommittedTranscript,
  shouldUseStaticTranscript,
} from "./committed-transcript.js";

describe("shouldUseStaticTranscript", () => {
  it("uses static transcript for Windows TTYs to reduce prompt repaint flicker", () => {
    expect(
      shouldUseStaticTranscript({
        env: {},
        isTTY: true,
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("keeps non-TTY renders dynamic so tests and redirected output stay replaceable", () => {
    expect(
      shouldUseStaticTranscript({
        env: {},
        isTTY: false,
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("allows explicit static transcript overrides", () => {
    expect(
      shouldUseStaticTranscript({
        env: { OHBABY_TUI_STATIC_TRANSCRIPT: "0" },
        isTTY: true,
        platform: "win32",
      }),
    ).toBe(false);
    expect(
      shouldUseStaticTranscript({
        env: { OHBABY_TUI_STATIC_TRANSCRIPT: " false " },
        isTTY: true,
        platform: "win32",
      }),
    ).toBe(false);
    expect(
      shouldUseStaticTranscript({
        env: { OHBABY_TUI_STATIC_TRANSCRIPT: "1" },
        isTTY: false,
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      shouldUseStaticTranscript({
        env: { OHBABY_TUI_STATIC_TRANSCRIPT: "TRUE" },
        isTTY: false,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("ignores blank or unknown overrides and falls back to platform detection", () => {
    expect(
      shouldUseStaticTranscript({
        env: { OHBABY_TUI_STATIC_TRANSCRIPT: "" },
        isTTY: true,
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      shouldUseStaticTranscript({
        env: { OHBABY_TUI_STATIC_TRANSCRIPT: "maybe" },
        isTTY: false,
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("renders forced static transcript items into stdout frames", () => {
    const previousOverride = process.env.OHBABY_TUI_STATIC_TRANSCRIPT;
    process.env.OHBABY_TUI_STATIC_TRANSCRIPT = "1";

    try {
      const app = render(
        <CommittedTranscript
          messages={[
            message("message_1", "first committed"),
            message("message_2", "last committed"),
          ]}
        />,
      );
      const output = app.stdout.frames.join("");

      expect(output).toContain("first committed");
      expect(output).toContain("last committed");

      app.unmount();
    } finally {
      if (previousOverride === undefined) {
        delete process.env.OHBABY_TUI_STATIC_TRANSCRIPT;
      } else {
        process.env.OHBABY_TUI_STATIC_TRANSCRIPT = previousOverride;
      }
    }
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
