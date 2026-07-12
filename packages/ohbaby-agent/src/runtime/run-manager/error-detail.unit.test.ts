import { describe, expect, it } from "vitest";
import { ProviderRetryExhaustedError } from "../../core/llm-client/index.js";
import {
  normalizeLifecycleRunError,
  normalizeRunError,
} from "./error-detail.js";

describe("normalizeRunError", () => {
  it("keeps provider status and retryability without serializing the raw error", () => {
    expect(
      normalizeRunError({
        message: "rate limited; Authorization: Bearer secret-token",
        status: 429,
      }),
    ).toEqual({
      code: "PROVIDER_API",
      message: "LLM provider rate limit was exceeded (HTTP 429)",
      retryable: true,
      source: "provider",
      statusCode: 429,
    });
  });

  it("preserves retry exhaustion allowlist fields without the provider cause message", () => {
    const cause = Object.assign(new Error("response body includes sk-secret"), {
      status: 503,
    });
    expect(
      normalizeRunError(new ProviderRetryExhaustedError(cause, 5)),
    ).toMatchObject({
      attempts: 5,
      code: "PROVIDER_RETRY_EXHAUSTED",
      message: "LLM provider request failed after 5 retries",
      retryable: true,
      source: "provider",
      statusCode: 503,
    });
  });

  it("maps provider authentication failures to a stable redacted code", () => {
    expect(
      normalizeRunError(
        Object.assign(new Error("Authorization: Bearer secret-token"), {
          status: 401,
        }),
      ),
    ).toEqual({
      code: "PROVIDER_AUTH",
      message: "LLM provider authentication failed (HTTP 401)",
      retryable: false,
      source: "provider",
      statusCode: 401,
    });
  });

  it("maps output truncation and cancellation to stable runtime codes", () => {
    expect(
      normalizeLifecycleRunError("output truncated", "output_length"),
    ).toEqual({
      code: "OUTPUT_LENGTH",
      message: "output truncated",
      retryable: false,
      source: "runtime",
      terminalReason: "output_length",
    });
    expect(normalizeLifecycleRunError("user cancelled", "cancelled")).toEqual({
      code: "ABORTED",
      message: "user cancelled",
      retryable: false,
      source: "runtime",
      terminalReason: "cancelled",
    });
  });
});
