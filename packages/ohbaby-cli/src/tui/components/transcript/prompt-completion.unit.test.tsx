import { render } from "ink-testing-library";
import type { UiTurn } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import { PromptCompletion } from "./prompt-completion.js";

const turn: UiTurn = {
  runId: "run_1",
  trigger: "user",
  timing: {
    id: "prompt_1",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:12Z",
    status: "failed",
    recovered: false,
  },
  error: {
    code: "PROVIDER_RETRY_EXHAUSTED",
    message: "Requests are temporarily limited. Please try again later.",
    retryable: true,
    source: "provider",
    providerId: "zenmux",
    statusCode: 429,
  },
};

describe("turn end line", () => {
  it("keeps a failed turn's reason in the history, with only the HTTP status", () => {
    const frame = render(<PromptCompletion turn={turn} />).lastFrame() ?? "";
    expect(frame).toContain("failed · Total 12s");
    expect(frame).toContain(
      "Error: Requests are temporarily limited. Please try again later. HTTP 429",
    );
    expect(frame).not.toContain("zenmux");
    expect(frame).not.toContain("PROVIDER_RETRY_EXHAUSTED");
  });

  it("says nothing more for a stop the user asked for", () => {
    const frame =
      render(
        <PromptCompletion
          turn={{
            ...turn,
            timing: { ...turn.timing, status: "interrupted" },
            error: {
              code: "RUN_INTERRUPTED",
              message: "user-stop",
              retryable: true,
              source: "runtime",
              terminalReason: "user-stop",
            },
          }}
        />,
      ).lastFrame() ?? "";
    expect(frame).toContain("interrupted · Total 12s");
    expect(frame).not.toContain("Error:");
  });
});
