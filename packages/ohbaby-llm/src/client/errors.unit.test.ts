import { APIUserAbortError as AnthropicUserAbortError } from "@anthropic-ai/sdk/error";
import { APIUserAbortError as OpenAIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { isAbortError, isContextOverflowError } from "./errors.js";

describe("isAbortError", () => {
  it("recognizes user aborts from every provider SDK", () => {
    expect(isAbortError(new OpenAIUserAbortError())).toBe(true);
    expect(isAbortError(new AnthropicUserAbortError())).toBe(true);
  });

  it("does not treat other errors as aborts", () => {
    expect(isAbortError(new Error("Request was aborted."))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

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
