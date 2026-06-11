export interface ProviderRetryPolicy {
  readonly maxRetriesPerStep: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryAfterCapMs: number;
}

export interface ProviderRetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly maxRetries: number;
  readonly reason: string;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxRetriesPerStep: 5,
  retryAfterCapMs: 60_000,
};

export class ProviderStreamInterruptedError extends Error {
  constructor(override readonly cause: unknown) {
    super(errorMessage(cause));
    this.name = "ProviderStreamInterruptedError";
  }
}

export class ProviderRetryExhaustedError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly attempts: number,
  ) {
    super(`Provider retry exhausted after ${String(attempts)} retries`);
    this.name = "ProviderRetryExhaustedError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericField(error: unknown, key: string): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function stringField(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const response = (error as { readonly response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const status = (response as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function providerErrorStatus(error: unknown): number | undefined {
  return (
    numericField(error, "status") ??
    numericField(error, "statusCode") ??
    responseStatus(error)
  );
}

export function retryReason(error: unknown): string {
  const status = providerErrorStatus(error);
  if (status !== undefined) {
    if (status === 429) {
      return "rate_limit";
    }
    if (status === 408) {
      return "request_timeout";
    }
    if (status >= 500) {
      return "server_error";
    }
  }

  const code = stringField(error, "code");
  if (code) {
    return code.toLowerCase();
  }
  return "connection_error";
}

export function isRetryableProviderError(error: unknown): boolean {
  const status = providerErrorStatus(error);
  if (
    status === 408 ||
    status === 429 ||
    status === 529 ||
    (status !== undefined && status >= 500 && status < 600)
  ) {
    return true;
  }

  const code = stringField(error, "code")?.toUpperCase();
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  );
}

function headerValue(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const headers = (error as { readonly headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  if (
    "get" in headers &&
    typeof (headers as { readonly get?: unknown }).get === "function"
  ) {
    const value = (headers as { get(name: string): unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const exact = record[name];
  const lower = record[name.toLowerCase()];
  const value = exact ?? lower;
  return typeof value === "string" ? value : undefined;
}

export function parseRetryAfterMs(error: unknown): number | undefined {
  const retryAfterMs = headerValue(error, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const parsed = Number(retryAfterMs);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  const retryAfter = headerValue(error, "retry-after");
  if (retryAfter === undefined) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(retryAfter);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}

export function resolveProviderRetryPolicy(
  policy?: Partial<ProviderRetryPolicy>,
): ProviderRetryPolicy {
  return {
    ...DEFAULT_PROVIDER_RETRY_POLICY,
    ...policy,
  };
}

export function nextRetryDelayMs(input: {
  readonly attempt: number;
  readonly error: unknown;
  readonly policy: ProviderRetryPolicy;
  readonly random?: () => number;
}): number {
  const retryAfter = parseRetryAfterMs(input.error);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, input.policy.retryAfterCapMs);
  }

  const base = Math.min(
    input.policy.initialDelayMs * 2 ** Math.max(0, input.attempt - 1),
    input.policy.maxDelayMs,
  );
  if (base <= 0) {
    return 0;
  }
  const random = input.random ?? Math.random;
  const jitter = 0.8 + random() * 0.4;
  return Math.floor(base * jitter);
}
