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
    ];

    for (const event of events) {
      renderer.handle(event);
    }

    expect(stdout).toEqual(["Hello", "OK\n"]);
    expect(stderr).toEqual(["INVALID_ARGS: Bad args\n"]);
  });
});

