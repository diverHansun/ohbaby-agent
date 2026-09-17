import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getModelJsonPath } from "./loaders.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";

// Coordination is process-local. Atomic file replacement protects each file;
// concurrent independent writers and crashes across two files are not transactions.
const queues = new Map<string, Promise<void>>();
const heldPaths = new AsyncLocalStorage<{ key: string; active: boolean }>();
const inconsistentPaths = new Set<string>();

export async function coordinateModelConfig<T>(
  path: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const key = resolve(path ?? getModelJsonPath());
  const held = heldPaths.getStore();
  if (held?.key === key && held.active) return work();
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  queues.set(key, current);
  await previous;
  const token = { key, active: true };
  try {
    return await heldPaths.run(token, work);
  } finally {
    token.active = false;
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

export function markModelConfigInconsistent(path: string): void {
  inconsistentPaths.add(resolve(path));
}
export function markModelConfigConsistent(path: string): void {
  inconsistentPaths.delete(resolve(path));
}
export function assertModelConfigConsistent(path = getModelJsonPath()): void {
  if (inconsistentPaths.has(resolve(path))) {
    throw new Error(
      "Model configuration was partially saved and rollback failed; save a repaired configuration before starting new work.",
    );
  }
}
export async function readOptionalConfigFile(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export function modelConfigVersion(
  modelPath = getModelJsonPath(),
  envPath = getGlobalEnvPath(),
): Promise<string> {
  return coordinateModelConfig(modelPath, async () => {
    assertModelConfigConsistent(modelPath);
    const [model, env] = await Promise.all([
      readOptionalConfigFile(modelPath),
      readOptionalConfigFile(envPath),
    ]);
    return createHash("sha256")
      .update(JSON.stringify([model, env]))
      .digest("hex");
  });
}

/** Network callbacks must not inherit reentrant publication ownership. */
export function outsideModelConfigCoordination<T>(work: () => T): T {
  return heldPaths.exit(work);
}
