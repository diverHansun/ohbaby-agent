export interface ShutdownOptions {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface CleanupResult {
  readonly status: "confirmed" | "unconfirmed";
  readonly errors: readonly string[];
}

// Existing resource owners return void; structured owners additionally report incomplete cleanup.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type CleanupTaskResult = void | CleanupResult;

function shutdownExpired(options: ShutdownOptions): boolean {
  return options.signal.aborted || Date.now() >= options.deadlineAt;
}

export function createShutdownOptions(timeoutMs = 10_000): ShutdownOptions {
  const timeout = Math.max(0, Math.floor(timeoutMs));
  return {
    deadlineAt: Date.now() + timeout,
    signal: AbortSignal.timeout(timeout),
  };
}

export async function withinShutdown<T>(
  options: ShutdownOptions,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const timeoutError = (): Error =>
    new Error(`${stage}: shutdown deadline exceeded`);
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0 || options.signal.aborted) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          reject(timeoutError());
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(onAbort, remaining);
      }),
    ]);
    if (shutdownExpired(options)) throw timeoutError();
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

export async function collectCleanup(
  options: ShutdownOptions,
  tasks: Readonly<
    Record<string, () => Promise<CleanupTaskResult> | CleanupTaskResult>
  >,
): Promise<CleanupResult> {
  const pending = new Set(Object.keys(tasks));
  const errors: string[] = [];
  const operations: Promise<void>[] = [];
  for (const [stage, task] of Object.entries(tasks)) {
    if (options.signal.aborted || Date.now() >= options.deadlineAt) break;
    try {
      operations.push(
        Promise.resolve(task())
          .then(
            (result) => {
              if (result?.status === "unconfirmed") {
                errors.push(
                  ...(result.errors.length
                    ? result.errors
                    : ["cleanup unconfirmed"]
                  ).map((error) => `${stage}: ${error}`),
                );
              }
            },
            (error: unknown) => {
              errors.push(
                `${stage}: ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          )
          .finally(() => {
            pending.delete(stage);
          }),
      );
    } catch (error) {
      errors.push(
        `${stage}: ${error instanceof Error ? error.message : String(error)}`,
      );
      pending.delete(stage);
    }
  }
  try {
    await withinShutdown(options, "cleanup", async () => {
      await Promise.all(operations);
    });
  } catch {
    for (const stage of pending)
      errors.push(`${stage}: shutdown deadline exceeded`);
    if (!pending.size && !errors.length)
      errors.push("cleanup: shutdown deadline exceeded");
  }
  return {
    status: errors.length ? "unconfirmed" : "confirmed",
    errors: [...errors],
  };
}
