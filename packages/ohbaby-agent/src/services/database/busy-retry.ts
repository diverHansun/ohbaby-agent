import { DatabaseBusyError } from "./errors.js";
import type { BusyRetryOptions } from "./types.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_JITTER_MS = 25;

function sleepBlocking(delayMs: number): void {
  if (delayMs <= 0) {
    return;
  }
  const waitBuffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(waitBuffer), 0, 0, delayMs);
}

function isSqliteBusy(error: unknown): boolean {
  const maybeError = error as { readonly code?: unknown; readonly message?: unknown };
  return (
    maybeError.code === "SQLITE_BUSY" ||
    (typeof maybeError.message === "string" &&
      maybeError.message.toLowerCase().includes("database is locked"))
  );
}

export function runWithBusyRetry<T>(
  operation: () => T,
  options: BusyRetryOptions = {},
): T {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepBlocking;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempts > maxRetries) {
        if (isSqliteBusy(error)) {
          throw new DatabaseBusyError(attempts, error);
        }
        throw error;
      }
      const delayMs =
        baseDelayMs * attempts + Math.floor(random() * Math.max(0, jitterMs));
      sleep(delayMs);
    }
  }
}
