import { describe, expect, it } from "vitest";
import type { UiMessagePart } from "ohbaby-sdk";
import { renderToolPart } from "./tool-part.js";

describe("renderToolPart", () => {
  it("uses a spinner slot while a tool call is running", () => {
    expect(
      renderToolPart(toolCall("bash", "running", { command: "pnpm test" })),
    ).toBe("⠋ Bash pnpm test");
  });

  it("keeps the leading slot after a tool call completes", () => {
    expect(
      renderToolPart(toolCall("bash", "completed", { command: "pnpm test" })),
    ).toBe("  Bash pnpm test");
  });

  it("hides successful result bodies", () => {
    expect(
      renderToolPart({
        result: {
          callId: "call_1",
          output: "raw output",
        },
        type: "tool-result",
      }),
    ).toBe("");
  });
});

function toolCall(
  name: string,
  status: "running" | "completed" | "failed",
  input: Record<string, unknown>,
): UiMessagePart {
  return {
    call: {
      id: "call_1",
      input,
      name,
      status,
    },
    type: "tool-call",
  };
}
