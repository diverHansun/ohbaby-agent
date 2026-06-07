import { describe, expect, it } from "vitest";
import type { UiMessagePart } from "ohbaby-sdk";
import { renderToolLabel, renderToolPart } from "./tool-part.js";

describe("renderToolLabel", () => {
  it("formats running tool calls without a spinner frame", () => {
    expect(
      renderToolLabel(
        toolCall("bash", "running", { command: "pnpm test" }).call,
      ),
    ).toBe("Bash pnpm test");
  });

  it("formats pending tool calls without a spinner frame", () => {
    expect(
      renderToolLabel(
        toolCall("bash", "pending", { command: "pnpm test" }).call,
      ),
    ).toBe("Bash pnpm test");
  });

  it("formats completed tool calls without a leading slot", () => {
    expect(
      renderToolLabel(
        toolCall("bash", "completed", { command: "pnpm test" }).call,
      ),
    ).toBe("Bash pnpm test");
  });
});

describe("renderToolPart", () => {
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
  status: "pending" | "running" | "completed" | "failed",
  input: Record<string, unknown>,
): Extract<UiMessagePart, { readonly type: "tool-call" }> {
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
