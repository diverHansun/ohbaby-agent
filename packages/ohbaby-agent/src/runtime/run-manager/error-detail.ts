import type { UiPromptError } from "ohbaby-sdk";
import {
  isRetryableProviderError,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
  providerErrorStatus,
} from "../../core/llm-client/index.js";

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

function providerCause(error: unknown): unknown {
  if (
    error instanceof ProviderRetryExhaustedError ||
    error instanceof ProviderStreamInterruptedError
  ) {
    return error.cause;
  }
  return error;
}

function providerMessage(
  error: unknown,
  statusCode: number | undefined,
): string {
  if (error instanceof ProviderRetryExhaustedError) {
    return `LLM provider request failed after ${String(error.attempts)} retries`;
  }
  if (error instanceof ProviderStreamInterruptedError) {
    return "LLM provider stream was interrupted";
  }
  if (statusCode === 401 || statusCode === 403) {
    return `LLM provider authentication failed (HTTP ${String(statusCode)})`;
  }
  if (statusCode === 429) {
    return "LLM provider rate limit was exceeded (HTTP 429)";
  }
  if (statusCode === 408) {
    return "LLM provider request timed out";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "LLM provider is unavailable";
  }
  return "LLM provider request failed";
}

export function normalizeRunError(error: unknown): UiPromptError {
  const cause = providerCause(error);
  const statusCode = providerErrorStatus(cause);
  const isProvider =
    error instanceof ProviderRetryExhaustedError ||
    error instanceof ProviderStreamInterruptedError ||
    statusCode !== undefined ||
    isRetryableProviderError(cause);
  if (!isProvider) {
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
        : statusCode === 401 || statusCode === 403
          ? "PROVIDER_AUTH"
          : "PROVIDER_API";
  return {
    code,
    message: providerMessage(error, statusCode),
    retryable:
      error instanceof ProviderRetryExhaustedError ||
      isRetryableProviderError(cause),
    source: "provider",
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(error instanceof ProviderRetryExhaustedError
      ? { attempts: error.attempts }
      : {}),
  };
}

export function normalizeLifecycleRunError(
  error: string,
  terminalReason: string | undefined,
  failureCause?: unknown,
): UiPromptError {
  if (failureCause !== undefined) {
    return normalizeRunError(failureCause);
  }
  if (terminalReason === "provider_retry_exhausted") {
    return {
      code: "PROVIDER_RETRY_EXHAUSTED",
      message: "LLM provider request failed after retries",
      retryable: true,
      source: "provider",
      terminalReason,
    };
  }
  if (terminalReason === "provider_stream_interrupted") {
    return {
      code: "PROVIDER_STREAM_INTERRUPTED",
      message: "LLM provider stream was interrupted",
      retryable: true,
      source: "provider",
      terminalReason,
    };
  }
  if (terminalReason === "output_length") {
    return {
      code: "OUTPUT_LENGTH",
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
