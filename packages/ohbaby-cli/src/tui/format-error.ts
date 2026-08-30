import { isStableErrorCode } from "ohbaby-sdk";

interface ErrorMessage {
  readonly code?: unknown;
  readonly message: string;
}

export function formatError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const value = error as ErrorMessage;
    return isStableErrorCode(value.code)
      ? `[${value.code}] ${value.message}`
      : value.message;
  }
  return String(error);
}
