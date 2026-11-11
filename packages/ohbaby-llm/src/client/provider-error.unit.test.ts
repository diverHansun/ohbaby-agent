import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk/error";
import { APIConnectionError, APIError, APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { providerErrorDetail } from "./index.js";
import { ProviderStreamIdleTimeoutError } from "./idle-watchdog.js";
import {
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "./retry.js";

const incompatibleTools = {
  status: 400,
  error: {
    type: "invalid_request_error",
    param: "reasoning_effort",
    message:
      "Function tools with reasoning_effort are not supported with this model in /v1/chat/completions.",
  },
};

describe("providerErrorDetail", () => {
  it("preserves the underlying reason after retry exhaustion and stream interruption", () => {
    expect(providerErrorDetail).toBeTypeOf("function");
    for (const [cause, kind, statusCode] of [
      [{ status: 429 }, "rate_limit", 429],
      [{ status: 401, code: "invalid_api_key" }, "invalid_api_key", 401],
      [{ status: 429, error: { code: "insufficient_quota" } }, "billing", 429],
      [incompatibleTools, "tools_reasoning_chat_unsupported", 400],
    ] as const) {
      const detail = providerErrorDetail(
        new ProviderRetryExhaustedError(cause, 5),
      );
      expect(detail).toMatchObject({ kind, statusCode, retryable: true });
      expect(detail?.message).toBe(providerErrorDetail(cause)?.message);
      expect(detail?.message).not.toMatch(/HTTP|\d/u);
    }
    const interrupted = providerErrorDetail(
      new ProviderStreamInterruptedError({ status: 429 }),
    );
    expect(interrupted).toMatchObject({
      kind: "stream_interrupted",
      statusCode: 429,
      retryable: true,
    });
    expect(interrupted?.message).toContain("The response was interrupted.");
    expect(interrupted?.message).toContain(
      providerErrorDetail({ status: 429 })?.message,
    );
    expect(
      providerErrorDetail(new ProviderStreamInterruptedError({ status: 401 })),
    ).toMatchObject({ kind: "stream_interrupted", retryable: false });
  });

  it("recognizes actionable request failures without copying provider text", () => {
    expect(providerErrorDetail(incompatibleTools)).toMatchObject({
      kind: "tools_reasoning_chat_unsupported",
      upstreamType: "invalid_request_error",
      retryable: false,
    });
    expect(providerErrorDetail(incompatibleTools)?.message).toContain(
      "Responses",
    );
    expect(
      providerErrorDetail({
        status: 400,
        error: { message: "temperature is deprecated for this model" },
      }),
    ).toMatchObject({ kind: "temperature_deprecated" });
    expect(providerErrorDetail({ status: 402 })).toMatchObject({
      kind: "billing",
    });
    expect(providerErrorDetail({ status: 403 })).toMatchObject({
      kind: "permission",
    });
    expect(
      providerErrorDetail({ status: 400, code: "context_length_exceeded" }),
    ).toMatchObject({ kind: "context_overflow", retryable: false });
  });

  it("keeps transport, timeout and availability causes with the existing retry semantics", () => {
    for (const [error, kind, retryable] of [
      [
        new APIConnectionError({
          cause: Object.assign(new Error("private proxy address"), {
            code: "ECONNREFUSED",
          }),
        }),
        "connection",
        true,
      ],
      [new ProviderStreamIdleTimeoutError(100, 100), "timeout", true],
      [{ status: 408 }, "timeout", true],
      [{ status: 408, cause: { code: "ECONNREFUSED" } }, "connection", true],
      [{ status: 408, cause: { code: "ETIMEDOUT" } }, "timeout", true],
      [{ status: 503 }, "unavailable", true],
      [{ code: "CERT_HAS_EXPIRED" }, "tls", false],
      [{ code: "OHBABY_PROXY_CONFIG" }, "proxy", false],
    ] as const) {
      expect(providerErrorDetail(error)).toMatchObject({ kind, retryable });
    }
  });

  it("bounds cause traversal and terminates cyclic graphs", () => {
    const cyclic: { status: number; cause?: unknown } = { status: 429 };
    cyclic.cause = cyclic;
    expect(providerErrorDetail(cyclic)).toMatchObject({ kind: "rate_limit" });
    let cause: unknown = { status: 401 };
    for (let depth = 0; depth < 15; depth++) cause = { cause };
    expect(providerErrorDetail(cause)).toMatchObject({
      kind: "authentication",
    });
    expect(providerErrorDetail({ cause })).toBeUndefined();
    const hostile = Object.defineProperty({}, "cause", {
      get() {
        throw new Error("private getter failure");
      },
    });
    expect(providerErrorDetail(hostile)).toBeUndefined();
  });

  it("allows only finite diagnostics and strict provider request IDs", () => {
    const secret =
      "sk-private-value https://private.example/prompt Bearer secret";
    const detail = providerErrorDetail({
      status: 400,
      message: secret,
      code: secret,
      type: secret,
      request_id: secret,
      headers: { "x-request-id": secret, authorization: secret },
      error: { message: secret, code: secret, type: secret, param: secret },
      cause: { message: secret, requestId: "arbitraryToken1234567890" },
    });
    expect(detail).toEqual({
      kind: "invalid_request",
      message: "The model rejected the request. Check the model configuration.",
      statusCode: 400,
      retryable: false,
    });
    expect(JSON.stringify(detail)).not.toContain(secret);
    for (const requestId of [
      "req_0123456789abcdef0123456789abcdef",
      "1e3cd164-14d2-40c6-a239-fb1dbeaa12a0",
    ]) {
      expect(
        providerErrorDetail({
          status: 401,
          request_id: requestId,
          error: {
            code: "invalid_api_key",
            type: "invalid_request_error",
          },
        }),
      ).toMatchObject({
        requestId,
        upstreamCode: "invalid_api_key",
        upstreamType: "invalid_request_error",
      });
    }
    for (const request_id of [
      "req_short",
      "req_" + "a".repeat(129),
      "req_abcdefghijklmnop/private",
    ]) {
      expect(
        providerErrorDetail({ status: 400, request_id }),
      ).not.toHaveProperty("requestId");
    }
  });

  it("reads the requestID field populated by both provider SDK constructors", () => {
    const requestId = "req_0123456789abcdef0123456789abcdef";
    const payload = { message: "private provider message" };
    for (const error of [
      new APIError(
        401,
        payload,
        undefined,
        new Headers({ "x-request-id": requestId }),
      ),
      new AnthropicAPIError(
        401,
        payload,
        undefined,
        new Headers({ "request-id": requestId }),
      ),
    ]) {
      expect(error.requestID).toBe(requestId);
      expect(providerErrorDetail(error)).toMatchObject({
        kind: "authentication",
        statusCode: 401,
        requestId,
      });
    }
  });

  it("keeps safe SDK errors when optional diagnostic getters throw", () => {
    const secret = "private provider payload";
    for (const field of ["request_id", "requestID", "code", "type"] as const) {
      const error = new APIError(
        401,
        { message: secret },
        undefined,
        undefined,
      );
      Object.defineProperty(error, field, {
        get() {
          throw new Error(secret);
        },
      });
      expect(providerErrorDetail(error)).toMatchObject({
        kind: "authentication",
        statusCode: 401,
        retryable: false,
        message: "Authentication failed. Check the model configuration.",
      });
      expect(JSON.stringify(providerErrorDetail(error))).not.toContain(secret);
    }
  });

  it("leaves unrelated runtime errors and user aborts to their existing owners", () => {
    for (const error of [
      undefined,
      null,
      "private message",
      new Error("private message"),
      new APIUserAbortError(),
    ]) {
      expect(providerErrorDetail(error)).toBeUndefined();
    }
  });
});
