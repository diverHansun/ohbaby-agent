import { describe, it, expect } from "vitest";
import { nativeOutputForMessage, type ModelState } from "./native-state.js";
const origin = {
  provider: "test",
  model: "m",
  protocol: "anthropic" as const,
  endpoint: "https://test/v1",
};
function state(): ModelState {
  return {
    version: 1,
    origin,
    output: {
      protocol: "anthropic",
      items: [
        { type: "thinking", thinking: "internal", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    },
    estimate: { tokens: 0, source: "text" },
  };
}
describe("native source and projection boundary", () => {
  it("accepts original source and unchanged text", () => {
    expect(
      nativeOutputForMessage(
        { role: "assistant", content: "answer", modelState: state() },
        origin,
      ),
    ).toEqual(state().output);
  });
  it("omits private state on another endpoint", () => {
    expect(
      nativeOutputForMessage(
        { role: "assistant", content: "answer", modelState: state() },
        { ...origin, endpoint: "https://other/v1" },
      ),
    ).toBeUndefined();
  });
  it("rejects edited text rather than replaying stale signed content", () => {
    expect(() =>
      nativeOutputForMessage(
        { role: "assistant", content: "edited", modelState: state() },
        origin,
      ),
    ).toThrow(/projection/i);
  });
  it("rejects missing tool projection", () => {
    const s = state();
    if (s.output.protocol === "anthropic")
      s.output.items.push({
        type: "tool_use",
        id: "call1",
        name: "read",
        input: {},
      });
    expect(() =>
      nativeOutputForMessage(
        { role: "assistant", content: "answer", modelState: s },
        origin,
      ),
    ).toThrow(/projection/i);
  });
  it("rejects an unknown state version", () => {
    expect(() =>
      nativeOutputForMessage(
        {
          role: "assistant",
          content: "answer",
          modelState: { ...state(), version: 2 } as unknown as ModelState,
        },
        origin,
      ),
    ).toThrow();
  });
});

it("rejects unknown native fields instead of silently dropping continuation data", async () => {
  const { NativeOutputSchema } = await import("./native-state.js");
  expect(() =>
    NativeOutputSchema.parse({
      protocol: "anthropic",
      items: [
        {
          type: "thinking",
          thinking: "a",
          signature: "s",
          future_state: "private",
        },
      ],
    }),
  ).toThrow();
});
