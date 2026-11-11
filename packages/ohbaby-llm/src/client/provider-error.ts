import { ModelRequestValidationError } from "../providers/request-validation-error.js";
import {
  APIError as AnthropicAPIError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
} from "@anthropic-ai/sdk/error";
import {
  APIError as OpenAIAPIError,
  APIConnectionTimeoutError as OpenAITimeoutError,
} from "openai";
import {
  isAbortError,
  isContextOverflowError,
  ProviderRequestError,
} from "./errors.js";
import { ProviderStreamIdleTimeoutError } from "./idle-watchdog.js";
import {
  isRetryableProviderError,
  providerErrorStatus,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "./retry.js";

export const PROVIDER_ERROR_KINDS = [
  "invalid_api_key",
  "authentication",
  "permission",
  "billing",
  "rate_limit",
  "timeout",
  "unavailable",
  "tools_reasoning_chat_unsupported",
  "temperature_deprecated",
  "invalid_request",
  "context_overflow",
  "connection",
  "tls",
  "proxy",
  "stream_interrupted",
  "unknown",
] as const;

export const SAFE_PROVIDER_ERROR_CODES = [
  "invalid_api_key",
  "invalid_request_error",
  "invalid_request",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_parameter",
  "invalid_argument",
  "model_not_found",
  "insufficient_quota",
  "insufficient_balance",
  "billing_hard_limit_reached",
  "rate_limit_exceeded",
  "context_length_exceeded",
  "permission_denied",
  "authentication_error",
  "overloaded_error",
  "server_error",
  "api_error",
] as const;

export const SAFE_PROVIDER_ERROR_TYPES = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "api_error",
  "server_error",
  "overloaded_error",
  "insufficient_quota",
  "invalid_argument",
  "invalid_parameter",
] as const;

export const SAFE_PROVIDER_NETWORK_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "OHBABY_PROXY_CONFIG",
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];
export type SafeProviderErrorCode = (typeof SAFE_PROVIDER_ERROR_CODES)[number];
export type SafeProviderErrorType = (typeof SAFE_PROVIDER_ERROR_TYPES)[number];
export type SafeProviderNetworkCode =
  (typeof SAFE_PROVIDER_NETWORK_CODES)[number];

export interface ProviderErrorDetail {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  /** Retry eligibility, never permission to replay a partially emitted response. */
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly upstreamCode?: SafeProviderErrorCode;
  readonly upstreamType?: SafeProviderErrorType;
  readonly requestId?: string;
  readonly networkCode?: SafeProviderNetworkCode;
}

const MESSAGES: Readonly<Record<ProviderErrorKind, string>> = {
  invalid_api_key:
    "The model service rejected the API key. Check the model configuration.",
  authentication: "Authentication failed. Check the model configuration.",
  permission: "Access to the model was denied. Check the model permissions.",
  billing:
    "The model service has insufficient credit or quota. Check billing or choose another model.",
  rate_limit: "Requests are temporarily limited. Please try again later.",
  timeout:
    "The model did not respond in time. Check the connection and try again.",
  unavailable:
    "The model service is temporarily unavailable. Please try again later.",
  tools_reasoning_chat_unsupported:
    "This model's tool requests require the Responses interface. Switch the model configuration to Responses.",
  temperature_deprecated:
    "This model no longer accepts temperature. Remove it from the model configuration.",
  invalid_request:
    "The model rejected the request. Check the model configuration.",
  context_overflow:
    "The request exceeds the model's context limit. Reduce the conversation or choose a model with a larger context window.",
  connection: "Could not reach the model. Check the connection and try again.",
  tls: "Could not establish a secure connection to the model. Check the certificates and proxy settings.",
  proxy: "The proxy configuration is invalid. Check the proxy settings.",
  stream_interrupted: "The response was interrupted. You can try again.",
  unknown: "The response could not be completed. Please try again.",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function field(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function causeChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = record(error);
  while (current && chain.length < 16 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = record(field(current, "cause"));
  }
  return chain;
}

function allowed<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return values.find((candidate) => candidate === value);
}

function status(error: unknown): number | undefined {
  try {
    const value = providerErrorStatus(error);
    return value !== undefined &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function isWrapper(error: unknown): boolean {
  return (
    error instanceof ProviderRequestError ||
    error instanceof ProviderRetryExhaustedError ||
    error instanceof ProviderStreamInterruptedError
  );
}

function providerNode(value: Record<string, unknown>): boolean {
  const nested = record(field(value, "error"));
  return (
    status(value) !== undefined ||
    value instanceof OpenAIAPIError ||
    value instanceof AnthropicAPIError ||
    value instanceof ProviderStreamIdleTimeoutError ||
    allowed(field(value, "code"), SAFE_PROVIDER_NETWORK_CODES) !== undefined ||
    [value, nested].some(
      (item) =>
        item !== undefined &&
        (allowed(field(item, "code"), SAFE_PROVIDER_ERROR_CODES) !==
          undefined ||
          allowed(field(item, "type"), SAFE_PROVIDER_ERROR_TYPES) !==
            undefined),
    )
  );
}

function retryable(value: Record<string, unknown>): boolean {
  try {
    return isRetryableProviderError(value);
  } catch {
    return isRetryableProviderError({
      status: status(value),
      code: field(value, "code"),
      type: field(value, "type"),
      message: field(value, "message"),
    });
  }
}

function requestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 132) return undefined;
  return /^req_[A-Za-z0-9]{16,128}$/u.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
    ? value
    : undefined;
}

function classify(
  chain: readonly Record<string, unknown>[],
  evidence: readonly Record<string, unknown>[],
  statusCode: number | undefined,
  networkCode: SafeProviderNetworkCode | undefined,
): Exclude<ProviderErrorKind, "stream_interrupted"> {
  const has = (values: readonly string[]): boolean =>
    evidence.some(
      (value) =>
        (typeof value.code === "string" && values.includes(value.code)) ||
        (typeof value.type === "string" && values.includes(value.type)),
    );
  const matches = (pattern: RegExp): boolean =>
    evidence.some(
      (value) =>
        typeof value.message === "string" && pattern.test(value.message),
    );

  if (has(["invalid_api_key"])) return "invalid_api_key";
  if (
    statusCode === 402 ||
    has([
      "insufficient_quota",
      "insufficient_balance",
      "billing_hard_limit_reached",
    ])
  )
    return "billing";
  if (statusCode === 400) {
    if (
      matches(
        /\bfunction tools\b[\s\S]*\breasoning_effort\b[\s\S]*\bnot supported\b[\s\S]*\/chat\/completions\b/iu,
      )
    )
      return "tools_reasoning_chat_unsupported";
    if (matches(/\btemperature\b[^\n]{0,200}\bdeprecated\b/iu))
      return "temperature_deprecated";
  }
  if (evidence.some(isContextOverflowError)) return "context_overflow";
  if (statusCode === 401 || has(["authentication_error"]))
    return "authentication";
  if (statusCode === 403 || has(["permission_denied", "permission_error"]))
    return "permission";
  if (statusCode === 429 || has(["rate_limit_exceeded", "rate_limit_error"]))
    return "rate_limit";
  if (networkCode === "OHBABY_PROXY_CONFIG") return "proxy";
  if (
    networkCode &&
    /CERT|SELF_SIGNED|ISSUER|LEAF_SIGNATURE|TLS/u.test(networkCode)
  )
    return "tls";
  if (
    networkCode !== undefined &&
    (statusCode === undefined || statusCode === 408)
  )
    return networkCode === "ETIMEDOUT" || networkCode.endsWith("_TIMEOUT")
      ? "timeout"
      : "connection";
  if (
    statusCode === 408 ||
    chain.some(
      (value) =>
        value instanceof ProviderStreamIdleTimeoutError ||
        value instanceof OpenAITimeoutError ||
        value instanceof AnthropicTimeoutError,
    )
  )
    return "timeout";
  if (statusCode !== undefined && statusCode >= 500) return "unavailable";
  if (statusCode !== undefined && statusCode >= 400) return "invalid_request";
  if (networkCode !== undefined || chain.some(retryable)) return "connection";
  if (
    has([
      "invalid_request",
      "invalid_request_error",
      "unsupported_parameter",
      "unsupported_value",
      "invalid_parameter",
      "invalid_argument",
      "model_not_found",
    ])
  )
    return "invalid_request";
  return "unknown";
}

function extractProviderError(error: unknown): ProviderErrorDetail | undefined {
  const chain = causeChain(error);
  const wrapped = chain.some(isWrapper);
  if (!wrapped && chain.some(isAbortError)) return undefined;
  const cause = chain.find((value) => !isWrapper(value) && providerNode(value));
  if (!wrapped && cause === undefined) return undefined;

  // Provider payloads are inspected only in memory; output is constructed field by field.
  const evidence = chain
    .flatMap((value) => {
      const nested = record(field(value, "error"));
      return nested === undefined ? [value] : [value, nested];
    })
    .map((value) => ({
      code: field(value, "code"),
      type: field(value, "type"),
      message: field(value, "message"),
      request_id: field(value, "request_id"),
      requestId: field(value, "requestId"),
      requestID: field(value, "requestID"),
      _request_id: field(value, "_request_id"),
    }));
  const statusCode = chain.map(status).find((value) => value !== undefined);
  const upstreamCode = evidence
    .map((value) => allowed(value.code, SAFE_PROVIDER_ERROR_CODES))
    .find((value) => value !== undefined);
  const upstreamType = evidence
    .map((value) => allowed(value.type, SAFE_PROVIDER_ERROR_TYPES))
    .find((value) => value !== undefined);
  const networkCode = chain
    .map((value) => allowed(field(value, "code"), SAFE_PROVIDER_NETWORK_CODES))
    .find((value) => value !== undefined);
  const providerRequestId = evidence
    .flatMap((value) => [
      value.request_id,
      value.requestId,
      value.requestID,
      value._request_id,
    ])
    .map(requestId)
    .find((value) => value !== undefined);
  const causeKind = classify(chain, evidence, statusCode, networkCode);
  const interrupted = chain.some(
    (value) => value instanceof ProviderStreamInterruptedError,
  );
  const kind = interrupted ? "stream_interrupted" : causeKind;
  return {
    kind,
    message:
      interrupted && causeKind !== "unknown"
        ? `The response was interrupted. ${MESSAGES[causeKind]}`
        : MESSAGES[kind],
    retryable:
      chain.some((value) => value instanceof ProviderRetryExhaustedError) ||
      (cause !== undefined && retryable(cause)),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
    ...(upstreamType === undefined ? {} : { upstreamType }),
    ...(providerRequestId === undefined
      ? {}
      : { requestId: providerRequestId }),
    ...(networkCode === undefined ? {} : { networkCode }),
  };
}

/** Safe shared provider meaning; unknown runtime failures remain with their owner. */
export function providerErrorDetail(
  error: unknown,
): ProviderErrorDetail | undefined {
  if (error instanceof ModelRequestValidationError) return undefined;
  try {
    return extractProviderError(error);
  } catch {
    // Diagnostics must never replace the request failure, even for hostile getters.
    try {
      if (isAbortError(error)) return undefined;
      if (
        isWrapper(error) ||
        error instanceof OpenAIAPIError ||
        error instanceof AnthropicAPIError
      ) {
        const kind =
          error instanceof ProviderStreamInterruptedError
            ? "stream_interrupted"
            : "unknown";
        return {
          kind,
          message: MESSAGES[kind],
          retryable: error instanceof ProviderRetryExhaustedError,
        };
      }
    } catch {
      // An uninspectable runtime object has no reliable provider provenance.
    }
    return undefined;
  }
}
