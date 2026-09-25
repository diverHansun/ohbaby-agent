import path from "node:path";

// Process-local protection for cooperating file mutations, not a cross-process lock.
const fileLockTails = new Map<string, Promise<void>>();

export interface FileLockOptions {
  readonly signal?: AbortSignal;
}

function fileLockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Serializes mutations by normalized path; this lock is not reentrant for that path.
 * The operation promise must cover all protected work, including reads and writes.
 * The signal only cancels waiting; once started, the operation must settle to unlock.
 */
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const key = fileLockKey(filePath);
  const previous = fileLockTails.get(key) ?? Promise.resolve();

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("File lock wait aborted", { cause: signal?.reason }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const execution = previous.then(async () => {
      signal?.removeEventListener("abort", onAbort);
      signal?.throwIfAborted();
      // Once started, only the actual operation's settlement releases ownership.
      // Execution deadlines and active cancellation belong to the caller.
      return await operation();
    });
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    fileLockTails.set(key, tail);
    void tail.then(() => {
      if (fileLockTails.get(key) === tail) fileLockTails.delete(key);
    });
    // Observe rejection even when cancellation already settled the waiting caller.
    void execution.then(resolve, reject);
  });
}
