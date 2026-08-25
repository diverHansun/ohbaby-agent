import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "./errors.js";

describe("isContextOverflowError", () => {
  it("recognizes structured provider context overflow codes", () => {
    expect(isContextOverflowError({ code: "context_length_exceeded" })).toBe(
      true,
    );
  });

  it("recognizes token limits only when they identify prompt input", () => {
    expect(
      isContextOverflowError(
        new Error("Prompt input reached the configured token limit"),
      ),
    ).toBe(true);
  });

  it("does not mistake an output token limit for context overflow", () => {
    expect(
      isContextOverflowError(
        new Error(
          "Model output reached the configured token limit before completion.",
        ),
      ),
    ).toBe(false);
  });
});
