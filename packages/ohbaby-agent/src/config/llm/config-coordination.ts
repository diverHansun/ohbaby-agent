import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  resolveOhbabyHome,
  resolveLegacyOhbabyHome,
  resolveProjectOhbabyRoot,
  resolveLegacyProjectOhbabyRoot,
  resolveReadPathWithLegacy,
} from "../../paths/index.js";
import { getModelJsonPath } from "./loaders.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import { resolveSearchJsonPath } from "../tools/search/loaders.js";

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

export type SettingsDomain =
  | "model"
  | "env"
  | "search"
  | "mcp"
  | "agents"
  | "skills";
export type SettingsConfigVersions = Readonly<Record<SettingsDomain, string>>;

/** Use the same current/legacy paths as the corresponding config loaders. */
export function settingsConfigVersion(
  projectDirectory: string,
): Promise<SettingsConfigVersions> {
  return coordinateModelConfig(undefined, async () => {
    assertModelConfigConsistent();
    const globalRoot = resolveOhbabyHome();
    const legacyGlobalRoot = resolveLegacyOhbabyHome();
    const projectRoot = resolveProjectOhbabyRoot(projectDirectory);
    const legacyProjectRoot = resolveLegacyProjectOhbabyRoot(projectDirectory);
    const read = async (
      root: string,
      legacyRoot: string,
      ...segments: string[]
    ): Promise<string | undefined> =>
      readOptionalConfigFile(
        await resolveReadPathWithLegacy(join(root, ...segments), [
          join(legacyRoot, ...segments),
        ]),
      );
    const hash = (values: readonly (string | undefined)[]): string =>
      createHash("sha256").update(JSON.stringify(values)).digest("hex");
    const layered = async (directory: string): Promise<string> =>
      hash(
        await Promise.all([
          read(globalRoot, legacyGlobalRoot, directory, "settings.json"),
          read(projectRoot, legacyProjectRoot, directory, "settings.json"),
        ]),
      );
    const [model, env, search, mcp, agents, skills] = await Promise.all([
      read(globalRoot, legacyGlobalRoot, "model.json").then((value) =>
        hash([value]),
      ),
      readOptionalConfigFile(getGlobalEnvPath()).then((value) => hash([value])),
      resolveSearchJsonPath()
        .then(readOptionalConfigFile)
        .then((value) => hash([value])),
      layered("mcp"),
      layered("agents"),
      layered("skills"),
    ]);
    return { model, env, search, mcp, agents, skills };
  });
}

/** Network callbacks must not inherit reentrant publication ownership. */
export function outsideModelConfigCoordination<T>(work: () => T): T {
  return heldPaths.exit(work);
}
