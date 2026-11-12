import { describe, expect, it } from "vitest";
import {
  ModelObservationError,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "ohbaby-llm";
import { ToolDeliveryError } from "../../core/tool-scheduler/delivery.js";
import {
  normalizeLifecycleRunError,
  normalizeRunError,
} from "./error-detail.js";

describe("normalizeRunError", () => {
  it("keeps the lifecycle's persistence summary even for raw HTTP-shaped storage causes", () => {
    for (const cause of [
      new Error("storage detail"),
      Object.assign(new Error("storage detail"), { status: 503 }),
    ]) {
      expect(
        normalizeLifecycleRunError(
          "Model response could not be saved",
          "model_state_persistence_failure",
          cause,
          "test-provider",
        ),
      ).toEqual({
        code: "RUNTIME_ERROR",
        message: "Model response could not be saved",
        source: "runtime",
        retryable: false,
        terminalReason: "model_state_persistence_failure",
      });
    }
    expect(
      normalizeLifecycleRunError(
        "Prepared runtime summary",
        undefined,
        new Error("raw detail"),
      ),
    ).toMatchObject({ source: "runtime", message: "Prepared runtime summary" });
  });

  it.each([
    {
      error: new ModelObservationError(
        Object.assign(new Error("storage unavailable"), { status: 503 }),
      ),
      terminalReason: "model_persistence_failure",
    },
    {
      error: new ToolDeliveryError(
        Object.assign(new Error("delivery connection lost"), {
          code: "ECONNRESET",
        }),
      ),
      terminalReason: "tool_persistence_failure",
    },
  ])("keeps $terminalReason owned by runtime", ({ error, terminalReason }) => {
    const expected = {
      code: "RUNTIME_ERROR",
      message: error.message,
      source: "runtime",
      retryable: false,
    };
    expect(normalizeRunError(error, "test-provider")).toEqual(expected);
    expect(
      normalizeLifecycleRunError(
        error.message,
        terminalReason,
        error,
        "test-provider",
      ),
    ).toEqual({ ...expected, terminalReason });
  });

  it("keeps provider status and retryability without serializing the raw error", () => {
    expect(
      normalizeRunError({
        message: "rate limited; Authorization: Bearer secret-token",
        status: 429,
      }),
    ).toEqual({
      code: "PROVIDER_API",
      message: "Requests are temporarily limited. Please try again later.",
      retryable: true,
      source: "provider",
      statusCode: 429,
    });
  });

  it("retains the actual rate-limit reason after exhaustion and keeps diagnostics off public errors", () => {
    const cause = {
      status: 429,
      code: "rate_limit_exceeded",
      request_id: "req_0123456789abcdef",
      message: "Authorization: Bearer secret",
    };
    const error = new ProviderRetryExhaustedError(cause, 5);
    const detail = normalizeLifecycleRunError(
      "wrapped",
      "provider_retry_exhausted",
      error,
      "zenmux",
    );
    expect(detail).toEqual({
      code: "PROVIDER_RETRY_EXHAUSTED",
      source: "provider",
      message: "Requests are temporarily limited. Please try again later.",
      retryable: true,
      statusCode: 429,
      attempts: 5,
      providerId: "zenmux",
      terminalReason: "provider_retry_exhausted",
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /secret|req_|rate_limit_exceeded/u,
    );
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
      message:
        "The model service is temporarily unavailable. Please try again later.",
      retryable: true,
      source: "provider",
      statusCode: 503,
    });
  });

  it("shows nested proxy connection causes while preserving retry metadata", () => {
    const socket = Object.assign(
      new Error("http://user:password@proxy/?key=sk-secret"),
      {
        code: "ECONNREFUSED",
      },
    );
    const proxy = new Error("secret proxy credentials", { cause: socket });
    const sdk = Object.assign(
      new Error("Request timed out", { cause: proxy }),
      {
        status: 408,
      },
    );
    expect(normalizeRunError(new ProviderRetryExhaustedError(sdk, 3))).toEqual({
      code: "PROVIDER_RETRY_EXHAUSTED",
      message: "Could not reach the model. Check the connection and try again.",
      source: "provider",
      retryable: true,
      statusCode: 408,
      attempts: 3,
    });
  });

  it("preserves stream interruption metadata with safe TLS details", () => {
    const cause = Object.assign(new Error("certificate for secret host"), {
      code: "CERT_HAS_EXPIRED",
    });
    expect(
      normalizeRunError(new ProviderStreamInterruptedError(cause)),
    ).toEqual({
      code: "PROVIDER_STREAM_INTERRUPTED",
      message:
        "The response was interrupted. Could not establish a secure connection to the model. Check the certificates and proxy settings.",
      retryable: false,
      source: "provider",
    });
  });

  it("handles cyclic causes and never copies secret-containing network messages", () => {
    const cause = {
      code: "ENOTFOUND",
      message: "sk-secret http://user:password@host",
      cause: {},
    };
    cause.cause = cause;
    const detail = normalizeRunError({ status: 408, cause });
    expect(detail.message).toBe(
      "Could not reach the model. Check the connection and try again.",
    );
    expect(JSON.stringify(detail)).not.toMatch(/sk-secret|password|http:/u);
  });

  it("bounds cause traversal and safely describes invalid proxy configuration", () => {
    expect(
      normalizeRunError({
        code: "OHBABY_PROXY_CONFIG",
        message: "http://secret@host",
      }).message,
    ).toBe("The proxy configuration is invalid. Check the proxy settings.");
    let cause: unknown = { code: "ENOTFOUND" };
    for (let i = 0; i < 40; i++) cause = { cause };
    expect(normalizeRunError({ status: 408, cause }).message).toBe(
      "The model did not respond in time. Check the connection and try again.",
    );
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
      message: "Authentication failed. Check the model configuration.",
      retryable: false,
      source: "provider",
      statusCode: 401,
    });
  });

  it("shows a useful 400 reason without exposing an authorization header", () => {
    const detail = normalizeRunError(
      Object.assign(
        new Error(
          "temperature is deprecated for this model; Authorization: Bearer sk-secret",
        ),
        { status: 400 },
      ),
    );
    expect(detail.message).toBe(
      "This model no longer accepts temperature. Remove it from the model configuration.",
    );
    expect(JSON.stringify(detail)).not.toContain("sk-secret");
  });

  it("shows a billing reason from a structured 402 response", () => {
    expect(
      normalizeRunError({
        status: 402,
        error: { message: "Insufficient balance for this request" },
      }),
    ).toMatchObject({
      code: "PROVIDER_API",
      message:
        "The model service has insufficient credit or quota. Check billing or choose another model.",
      retryable: false,
      statusCode: 402,
    });
  });

  it("never persists an unrecognized credential from a provider error", () => {
    const detail = normalizeRunError({
      status: 400,
      error: { message: "invalid credential zm-private-example" },
    });
    expect(detail.message).toBe(
      "The model rejected the request. Check the model configuration.",
    );
    expect(JSON.stringify(detail)).not.toContain("zm-private-example");
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

it("maps content filtering to a non-retryable terminal error", () => {
  expect(
    normalizeLifecycleRunError("filtered", "content_filter"),
  ).toMatchObject({
    code: "CONTENT_FILTER",
    retryable: false,
    terminalReason: "content_filter",
  });
});
