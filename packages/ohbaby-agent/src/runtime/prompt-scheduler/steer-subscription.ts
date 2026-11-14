import type { CurrentRunInputStore } from "./current-run-inputs.js";

/** Ignore bookkeeping/result changes; only a newly accepted user steer interrupts tool waits. */
export async function subscribeRunSteer(
  inputs: CurrentRunInputStore,
  runId: string,
  wake: () => void,
  signal?: AbortSignal,
): Promise<() => void> {
  const initial = new Set(
    (await inputs.listByRun(runId)).map((row) => row.inputId),
  );
  let disposed = false;
  let scanning = Promise.resolve();
  const isDisposed = (): boolean => disposed;
  const isAborted = (): boolean => signal?.aborted === true;
  const dispose = (): void => {
    disposed = true;
    unsubscribe();
    signal?.removeEventListener("abort", dispose);
  };
  const scan = (): void => {
    scanning = scanning
      .then(async () => {
        if (disposed) return;
        const rows = await inputs.listByRun(runId);
        if (
          !isDisposed() &&
          rows.some(
            (row) => row.source === "user-steer" && !initial.has(row.inputId),
          )
        ) {
          dispose();
          wake();
        }
      })
      .catch(() => {
        // A failed read must not interrupt a tool as if a user had steered it.
        // The next input change retries the scan; cancellation still disposes it.
      });
  };
  if (isAborted()) return () => undefined;
  const unsubscribe = inputs.subscribe(runId, scan);
  signal?.addEventListener("abort", dispose, { once: true });
  if (isAborted()) dispose();
  scan(); // Close the initial-read/subscription race.
  return dispose;
}
