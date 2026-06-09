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

  it("formats connect output without exposing internal context window source", () => {
    const stdout: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => stdout.push(chunk),
    });

    renderer.handle({
      clientInvocationId: "inv_connect",
      commandRunId: "cmd_connect",
      output: {
        data: {
          result: {
            apiKeyEnv: "ZENMUX_API_KEY",
            baseUrl: "https://zenmux.ai/api/anthropic",
            contextWindowSource: "detected",
            contextWindowTokens: 262_144,
            interfaceProvider: "anthropic",
            model: "moonshotai/kimi-k2.6",
            provider: "zenmux",
            saved: true,
          },
        },
        kind: "data",
        subject: "model.connected",
      },
      timestamp: 1,
      type: "command.result.delivered",
    });

    expect(stdout.join("")).toContain("model connected:");
    expect(stdout.join("")).toContain("moonshotai/kimi-k2.6");
    expect(stdout.join("")).toContain("262,144");
    expect(stdout.join("")).not.toContain("contextWindowSource");
    expect(stdout.join("")).not.toContain("detected");
  });

  it("prints connect warnings without exposing internal context window source", () => {
    const stdout: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => stdout.push(chunk),
    });

    renderer.handle({
      clientInvocationId: "inv_connect",
      commandRunId: "cmd_connect",
      output: {
        data: {
          result: {
            apiKeyEnv: "ZENMUX_API_KEY",
            baseUrl: "https://zenmux.ai/api/anthropic",
            contextWindowSource: "default",
            contextWindowTokens: 128_000,
            interfaceProvider: "anthropic",
            model: "moonshotai/kimi-k2.6",
            provider: "zenmux",
            saved: true,
            warning:
              "Unable to detect model context window from metadata; using the configured fallback.",
          },
        },
        kind: "data",
        subject: "model.connected",
      },
      timestamp: 1,
      type: "command.result.delivered",
    });

    expect(stdout.join("")).toContain("warning: Unable to detect");
    expect(stdout.join("")).not.toContain("contextWindowSource");
    expect(stdout.join("")).not.toContain("default");
  });
});
