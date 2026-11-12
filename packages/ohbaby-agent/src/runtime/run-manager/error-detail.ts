import type { UiPromptError } from "ohbaby-sdk";
import {
  ModelObservationError,
  providerErrorDetail,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "ohbaby-llm";
import { ToolDeliveryError } from "../../core/tool-scheduler/delivery.js";

function message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function normalizeRunError(
  error: unknown,
  providerId?: string,
): UiPromptError {
  // These owners may wrap HTTP/network failures from saving or delivery.
  // Their causes do not identify a failed model request.
  const detail =
    error instanceof ModelObservationError || error instanceof ToolDeliveryError
      ? undefined
      : providerErrorDetail(error);
  if (!detail) {
    return {
      code: "RUNTIME_ERROR",
      message: message(error),
      retryable: false,
      source: "runtime",
    };
  }
  const code =
    error instanceof ProviderRetryExhaustedError
      ? "PROVIDER_RETRY_EXHAUSTED"
      : error instanceof ProviderStreamInterruptedError
        ? "PROVIDER_STREAM_INTERRUPTED"
        : detail.statusCode === 401 || detail.statusCode === 403
          ? "PROVIDER_AUTH"
          : "PROVIDER_API";
  return {
    code,
    message: detail.message,
    retryable: detail.retryable,
    source: "provider",
    ...(providerId === undefined ? {} : { providerId }),
    ...(detail.statusCode === undefined
      ? {}
      : { statusCode: detail.statusCode }),
    ...(error instanceof ProviderRetryExhaustedError
      ? { attempts: error.attempts }
      : {}),
  };
}

export function normalizeLifecycleRunError(
  error: string,
  terminalReason: string | undefined,
  failureCause?: unknown,
  providerId?: string,
): UiPromptError {
  if (
    terminalReason === "model_persistence_failure" ||
    terminalReason === "model_state_persistence_failure" ||
    terminalReason === "tool_persistence_failure"
  ) {
    return {
      code: "RUNTIME_ERROR",
      message: error,
      retryable: false,
      source: "runtime",
      terminalReason,
    };
  }
  if (failureCause !== undefined) {
    const detail = normalizeRunError(failureCause, providerId);
    return {
      ...detail,
      ...(detail.source === "runtime" ? { message: error } : {}),
      ...(terminalReason === undefined ? {} : { terminalReason }),
    };
  }
  if (terminalReason === "provider_retry_exhausted") {
    return {
      code: "PROVIDER_RETRY_EXHAUSTED",
      message: "The response could not be completed. Please try again.",
      retryable: true,
      source: "provider",
      terminalReason,
    };
  }
  if (terminalReason === "provider_stream_interrupted") {
    return {
      code: "PROVIDER_STREAM_INTERRUPTED",
      message: "The response was interrupted. You can try again.",
      retryable: true,
      source: "provider",
      terminalReason,
    };
  }
  if (
    terminalReason === "output_length" ||
    terminalReason === "content_filter"
  ) {
    return {
      code:
        terminalReason === "content_filter"
          ? "CONTENT_FILTER"
          : "OUTPUT_LENGTH",
      message: error,
      retryable: false,
      source: "runtime",
      terminalReason,
    };
  }
  if (terminalReason === "cancelled") {
    return {
      code: "ABORTED",
      message: error,
      retryable: false,
      source: "runtime",
      terminalReason,
    };
  }
  return {
    code:
      terminalReason === "context_overflow"
        ? "CONTEXT_OVERFLOW"
        : terminalReason === undefined
          ? "LIFECYCLE_FAILED"
          : terminalReason.toUpperCase(),
    message: error,
    retryable: terminalReason !== "context_overflow",
    source: "runtime",
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}
