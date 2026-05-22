import { describe, expect, it } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import { createStdoutRenderer } from "./stdout-renderer.js";

describe("createStdoutRenderer", () => {
  it("renders assistant deltas and command events", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => stdout.push(chunk),
      writeError: (chunk) => stderr.push(chunk),
    });

    const events: UiEvent[] = [
      {
        type: "message.part.delta",
        sessionId: "session_1",
        delta: "Hello",
      },
      {
        type: "command.result.delivered",
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        output: { kind: "text", text: "OK" },
        timestamp: 1,
      },
      {
        type: "command.failed",
        clientInvocationId: "inv_2",
        commandRunId: "cmd_2",
        error: { code: "INVALID_ARGS", message: "Bad args" },
        timestamp: 2,
      },
      {
        type: "notice.emitted",
        notice: {
          createdAt: "2026-05-19T00:00:00.000Z",
          id: "notice_1",
          key: "prompt-security:/repo/OHBABY.md",
          level: "warning",
          message:
            "OHBABY.md was skipped because it tried to override instructions.",
          source: "/repo/OHBABY.md",
          title: "Custom instructions skipped",
        },
        timestamp: 3,
      },
    ];

    for (const event of events) {
      renderer.handle(event);
    }

    expect(stdout).toEqual(["Hello", "OK\n"]);
    expect(stderr).toEqual([
      "INVALID_ARGS: Bad args\n",
      "warning: Custom instructions skipped: OHBABY.md was skipped because it tried to override instructions. (/repo/OHBABY.md)\n",
    ]);
  });
});
