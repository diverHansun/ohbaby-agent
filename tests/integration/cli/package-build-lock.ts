import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lockDirectory = join(tmpdir(), "ohbaby-cli-package-build.lock");
const lockTimeoutMs = 180_000;
const retryMs = 100;
const staleLockMs = 5 * 60_000;

export async function withCliPackageBuildLock<T>(
  action: () => Promise<T>,
): Promise<T> {
  const lock = await acquireCliPackageBuildLock();
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

export async function acquireCliPackageBuildLock(): Promise<{
  readonly release: () => Promise<void>;
}> {
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDirectory);
      return {
        release: () => rm(lockDirectory, { force: true, recursive: true }),
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    await removeStaleLock();
    if (Date.now() - startedAt > lockTimeoutMs) {
      throw new Error("Timed out waiting for CLI package build lock");
    }
    await delay(retryMs);
  }
}

async function removeStaleLock(): Promise<void> {
  try {
    const info = await stat(lockDirectory);
    if (Date.now() - info.mtimeMs > staleLockMs) {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
