import {
  withResources,
  type ResourceLease,
} from "../../core/tool-scheduler/resources.js";

export interface FileLockOptions {
  readonly signal?: AbortSignal;
  readonly lease?: ResourceLease;
}

/**
 * Process-local protection shared with scheduled tools and direct file operations.
 * The operation promise must cover all protected work, including late settlement.
 * Cancellation only stops waiting; active work owns the resource until it settles.
 */
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  return await withResources(
    [{ kind: "file", path: filePath, scope: "file", mode: "write" }],
    operation,
    options,
  );
}
