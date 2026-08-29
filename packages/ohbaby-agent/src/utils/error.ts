import { isStableErrorCode } from "ohbaby-sdk";

function hasMessage(value: unknown): value is { readonly message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function hasStableErrorCode(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  try {
    return (
      hasMessage(value) &&
      "code" in value &&
      isStableErrorCode(value.code)
    );
  } catch {
    return false;
  }
}

export class IrisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  static isInstance(error: unknown): error is IrisError {
    return error instanceof IrisError;
  }

  toObject(): {
    readonly code: string;
    readonly data?: Record<string, unknown>;
    readonly message: string;
  } {
    return {
      code: this.code,
      data: this.data,
      message: this.message,
    };
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error || hasMessage(error)) {
    return error.message;
  }
  return String(error);
}

export function formatError(error: unknown): string {
  if (hasStableErrorCode(error)) {
    return `[${error.code}] ${error.message}`;
  }
  return getErrorMessage(error);
}
