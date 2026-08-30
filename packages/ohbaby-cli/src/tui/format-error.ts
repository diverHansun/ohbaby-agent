import { isStableErrorCode } from "ohbaby-sdk";

interface ErrorMessage {
  readonly code?: unknown;
  readonly message?: unknown;
}

export function formatError(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "message" in error) {
      const value = error as ErrorMessage;
      const message = value.message;
      if (typeof message === "string") {
        let code: unknown;
        try {
          code = value.code;
        } catch {
          return message;
        }
        return isStableErrorCode(code) ? `[${code}] ${message}` : message;
      }
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}
