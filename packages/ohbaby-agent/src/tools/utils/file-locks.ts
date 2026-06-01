import path from "node:path";

const DEFAULT_FILE_LOCK_TIMEOUT_MS = 120_000;

const fileLockTails = new Map<string, Promise<void>>();

export interface FileLockOptions {
  readonly timeoutMs?: number;
}

function fileLockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getTimeoutMs(options: FileLockOptions | undefined): number {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FILE_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("File lock timeout must be a positive finite number.");
  }
  return timeoutMs;
}

async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`File lock timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    if (typeof timeout === "object" && "unref" in timeout) {
      timeout.unref();
    }
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const key = fileLockKey(filePath);
  const timeoutMs = getTimeoutMs(options);
  const previous = fileLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queuedTail = previous.catch(() => undefined).then(() => current);
  fileLockTails.set(key, queuedTail);

  await previous.catch(() => undefined);
  try {
    return await runWithTimeout(operation, timeoutMs);
  } finally {
    release();
    // The map stores the newest queue tail. Delete only when no later waiter
    // replaced this tail while the current operation was running.
    if (fileLockTails.get(key) === queuedTail) {
      fileLockTails.delete(key);
    }
  }
}
