import {
  ProviderStreamEofError,
  ProviderStreamFailureError,
} from "../providers/stream-errors.js";
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
  isProviderTransportError,
  isRetryableProviderError,
  retryReason,
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
  "invalid_prompt",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_parameter",
  "invalid_argument",
  "model_not_found",
  "insufficient_quota",
  "insufficient_balance",
  "billing_hard_limit_reached",
  "rate_limit_exceeded",
  "server_is_overloaded",
  "context_length_exceeded",
  "permission_denied",
  "authentication_error",
  "overloaded_error",
  "server_error",
  "api_error",
  "content_policy_violation",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
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

/** Diagnostic labels only: never retain arbitrary provider prose. */
export const SAFE_UPSTREAM_REASONS = [
  "concurrency_limit",
  "invalid_reasoning_content",
  "invalid_tool_request",
  "stream_eof",
] as const;

export function safeUpstreamId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  return /^(?:req_[A-Za-z0-9]{8,100}|[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/u.test(
    value,
  )
    ? value
    : undefined;
}

function upstreamReason(
  evidence: readonly Record<string, unknown>[],
): (typeof SAFE_UPSTREAM_REASONS)[number] | undefined {
  for (const item of evidence) {
    if (typeof item.message !== "string") continue;
    const message = item.message.slice(0, 4096);
    if (
      /\b(?:concurrent requests?|request concurrency)\b[^\n]{0,160}(?:limit|exceed|maximum)|(?:limit|exceed|maximum|too many)[^\n]{0,160}\b(?:concurrent requests?|request concurrency)\b/iu.test(
        message,
      )
    )
      return "concurrency_limit";
    if (
      /(?:missing|required|must)[^\n]{0,160}reasoning_content|reasoning_content[^\n]{0,160}(?:missing|required|must)/iu.test(
        message,
      )
    )
      return "invalid_reasoning_content";
    if (
      /tool_(?:call_id|calls)[^\n]{0,160}(?:missing|match|respond|follow)|(?:missing|match|respond|follow)[^\n]{0,160}tool_(?:call_id|calls)/iu.test(
        message,
      )
    )
      return "invalid_tool_request";
  }
  return undefined;
}

export interface ProviderErrorDetail {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  /** Retry eligibility, never permission to replay a partially emitted response. */
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly upstreamCode?: SafeProviderErrorCode;
  readonly upstreamType?: SafeProviderErrorType;
  readonly networkCode?: SafeProviderNetworkCode;
  readonly upstreamReason?: (typeof SAFE_UPSTREAM_REASONS)[number];
  readonly upstreamId?: string;
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

function causeChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = record(error);
  while (current && chain.length < 16 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = record(current.cause);
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
  const value = providerErrorStatus(error);
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function isWrapper(error: unknown): boolean {
  return (
    error instanceof ProviderRequestError ||
    error instanceof ProviderRetryExhaustedError ||
    error instanceof ProviderStreamInterruptedError
  );
}

function providerNode(value: Record<string, unknown>): boolean {
  const nested = record(value.error);
  return (
    status(value) !== undefined ||
    value instanceof OpenAIAPIError ||
    value instanceof AnthropicAPIError ||
    value instanceof ProviderStreamFailureError ||
    value instanceof ProviderStreamEofError ||
    value instanceof ProviderStreamIdleTimeoutError ||
    allowed(value.code, SAFE_PROVIDER_NETWORK_CODES) !== undefined ||
    [value, nested].some(
      (item) =>
        item !== undefined &&
        (allowed(item.code, SAFE_PROVIDER_ERROR_CODES) !== undefined ||
          allowed(item.type, SAFE_PROVIDER_ERROR_TYPES) !== undefined),
    )
  );
}

const RATE_LIMIT_ERRORS = ["rate_limit_exceeded", "rate_limit_error"];

const UNAVAILABLE_ERRORS = [
  "server_error",
  "api_error",
  "overloaded_error",
  "server_is_overloaded",
];

const BILLING_ERRORS = [
  "insufficient_quota",
  "insufficient_balance",
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
];

const INVALID_REQUEST_ERRORS = [
  "invalid_request",
  "invalid_request_error",
  "invalid_prompt",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_parameter",
  "invalid_argument",
  "model_not_found",
  "not_found_error",
  "content_policy_violation",
];

function matchesErrorLabel(
  value: Record<string, unknown>,
  labels: readonly string[],
): string | undefined {
  return allowed(value.code, labels) ?? allowed(value.type, labels);
}

function isPermanentNetworkCode(code: unknown): boolean {
  const safe = allowed(code, SAFE_PROVIDER_NETWORK_CODES);
  return (
    safe !== undefined &&
    (safe === "OHBABY_PROXY_CONFIG" ||
      /CERT|SELF_SIGNED|ISSUER|LEAF_SIGNATURE|TLS/u.test(safe))
  );
}

/** Decide eligibility for agent steps independently of user-facing error normalization. */
export function agentStepRetry(
  error: unknown,
  hasOutput: boolean,
): { reason: string; source?: "eof" | "transport" } | undefined {
  if (error instanceof ProviderStreamInterruptedError && error.source === "eof")
    return { reason: "stream_eof", source: "eof" };
  if (error instanceof ProviderStreamIdleTimeoutError)
    return { reason: "stream_idle_timeout" };

  const chain = causeChain(error);
  const upstream = chain.filter(
    (node) =>
      node instanceof OpenAIAPIError ||
      node instanceof AnthropicAPIError ||
      node instanceof ProviderStreamFailureError,
  );
  const evidence = upstream.flatMap((node) => {
    const payload = record(node.error);
    return payload ? [node, payload] : [node];
  });
  if (
    evidence.some(
      (node) =>
        isContextOverflowError(node) ||
        matchesErrorLabel(node, BILLING_ERRORS) !== undefined ||
        matchesErrorLabel(node, INVALID_REQUEST_ERRORS) !== undefined ||
        matchesErrorLabel(node, [
          "invalid_api_key",
          "authentication_error",
          "permission_error",
          "permission_denied",
        ]) !== undefined,
    ) ||
    chain.some((node) => isPermanentNetworkCode(node.code)) ||
    (providerErrorStatus(error) !== undefined &&
      !isRetryableProviderError(error))
  ) {
    return undefined;
  }

  const transport = chain.find(
    (node) =>
      isProviderTransportError(node) ||
      node.code === "UND_ERR_SOCKET" ||
      node.code === "UND_ERR_CONNECT_TIMEOUT" ||
      node.code === "UND_ERR_HEADERS_TIMEOUT" ||
      node.code === "UND_ERR_BODY_TIMEOUT",
  );
  if (transport) {
    const networkCode = chain
      .map((node) => allowed(node.code, SAFE_PROVIDER_NETWORK_CODES))
      .find((code) => code !== undefined);
    return {
      reason: networkCode?.toLowerCase() ?? retryReason(transport),
      source: "transport",
    };
  }

  for (const node of evidence) {
    const reason =
      matchesErrorLabel(node, RATE_LIMIT_ERRORS) ??
      matchesErrorLabel(node, UNAVAILABLE_ERRORS);
    if (reason !== undefined) return { reason };
  }

  // Before output, keep accepting HTTP failures from custom adapters.
  if (
    (!hasOutput || upstream.some((node) => node === error)) &&
    isRetryableProviderError(error)
  )
    return { reason: retryReason(error) };
  return undefined;
}

function classify(
  chain: readonly Record<string, unknown>[],
  evidence: readonly Record<string, unknown>[],
  statusCode: number | undefined,
  networkCode: SafeProviderNetworkCode | undefined,
): Exclude<ProviderErrorKind, "stream_interrupted"> {
  const has = (values: readonly string[]): boolean =>
    evidence.some((value) => matchesErrorLabel(value, values) !== undefined);
  const matches = (pattern: RegExp): boolean =>
    evidence.some(
      (value) =>
        typeof value.message === "string" && pattern.test(value.message),
    );

  if (has(["invalid_api_key"])) return "invalid_api_key";
  if (statusCode === 402 || has(BILLING_ERRORS)) return "billing";
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
  if (statusCode === 429 || has(RATE_LIMIT_ERRORS)) return "rate_limit";
  if (networkCode === "OHBABY_PROXY_CONFIG") return "proxy";
  if (isPermanentNetworkCode(networkCode)) return "tls";
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
  if (
    (statusCode !== undefined && statusCode >= 500) ||
    has(UNAVAILABLE_ERRORS)
  )
    return "unavailable";
  if (statusCode !== undefined && statusCode >= 400) return "invalid_request";
  if (networkCode !== undefined || chain.some(isRetryableProviderError))
    return "connection";
  if (has(INVALID_REQUEST_ERRORS)) return "invalid_request";
  return "unknown";
}

/** Safe shared provider meaning; unknown runtime failures remain with their owner. */
export function providerErrorDetail(
  error: unknown,
): ProviderErrorDetail | undefined {
  let knownProvider = false;
  let interrupted = false;
  let exhausted = false;
  try {
    if (error instanceof ModelRequestValidationError || isAbortError(error))
      return undefined;
    knownProvider =
      isWrapper(error) ||
      error instanceof OpenAIAPIError ||
      error instanceof AnthropicAPIError;
    interrupted = error instanceof ProviderStreamInterruptedError;
    exhausted = error instanceof ProviderRetryExhaustedError;
    const chain = causeChain(error);
    const wrapped = chain.some(isWrapper);
    if (!wrapped && chain.some(isAbortError)) return undefined;
    knownProvider ||= wrapped;
    // Retain provenance before reading optional details or later cause nodes.
    const cause = chain.find((value) => {
      const recognized = !isWrapper(value) && providerNode(value);
      if (recognized) knownProvider = true;
      return recognized;
    });
    if (!knownProvider) return undefined;
    interrupted ||= chain.some(
      (value) => value instanceof ProviderStreamInterruptedError,
    );
    exhausted ||= chain.some(
      (value) => value instanceof ProviderRetryExhaustedError,
    );
    // Provider payloads are inspected only in memory; output is constructed field by field.
    const evidence = chain
      .flatMap((value) => {
        const nested = record(value.error);
        return nested === undefined ? [value] : [value, nested];
      })
      .map((value) => ({
        code: value.code,
        type: value.type,
        message: value.message,
      }));
    const statusCode = chain.map(status).find((value) => value !== undefined);
    const upstreamCode = evidence
      .map((value) => allowed(value.code, SAFE_PROVIDER_ERROR_CODES))
      .find((value) => value !== undefined);
    const upstreamType = evidence
      .map((value) => allowed(value.type, SAFE_PROVIDER_ERROR_TYPES))
      .find((value) => value !== undefined);
    const networkCode = chain
      .map((value) => allowed(value.code, SAFE_PROVIDER_NETWORK_CODES))
      .find((value) => value !== undefined);
    // Optional diagnostics cannot erase the core error if a hostile getter throws.
    let upstreamId: string | undefined;
    try {
      upstreamId = chain
        .map((value) =>
          safeUpstreamId(
            value instanceof OpenAIAPIError ||
              value instanceof AnthropicAPIError
              ? value.requestID
              : value.request_id,
          ),
        )
        .find(Boolean);
    } catch {
      /* Keep the already classified failure. */
    }
    const reason = chain.some(
      (value) =>
        value instanceof ProviderStreamInterruptedError &&
        value.source === "eof",
    )
      ? "stream_eof"
      : upstreamReason(evidence);
    const causeKind = classify(chain, evidence, statusCode, networkCode);
    const kind = interrupted ? "stream_interrupted" : causeKind;
    return {
      kind,
      ...(reason === undefined ? {} : { upstreamReason: reason }),
      ...(upstreamId === undefined ? {} : { upstreamId }),
      message:
        interrupted && causeKind !== "unknown"
          ? `The response was interrupted. ${MESSAGES[causeKind]}`
          : MESSAGES[kind],
      retryable:
        chain.some((value) => value instanceof ProviderRetryExhaustedError) ||
        (cause !== undefined && isRetryableProviderError(cause)),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
      ...(upstreamType === undefined ? {} : { upstreamType }),
      ...(networkCode === undefined ? {} : { networkCode }),
    };
  } catch {
    if (!knownProvider) return undefined;
    const kind = interrupted ? "stream_interrupted" : "unknown";
    return { kind, message: MESSAGES[kind], retryable: exhausted };
  }
}
