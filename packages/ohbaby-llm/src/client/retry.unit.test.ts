import { describe, expect, it } from "vitest";
import { isRetryableProviderError } from "./retry.js";

describe("provider retry classification", () => {
  it.each([
    { status: 503, code: "context_length_exceeded" },
    { status: 429, message: "maximum context window exceeded" },
    { code: "ECONNRESET", message: "input token limit exceeded" },
  ])(
    "excludes context overflow before transient classification: %j",
    (error) => {
      expect(isRetryableProviderError(error)).toBe(false);
    },
  );

  it.each([{ status: 503 }, { status: 429 }, { code: "ECONNRESET" }])(
    "preserves ordinary transient retries: %j",
    (error) => {
      expect(isRetryableProviderError(error)).toBe(true);
    },
  );
});
