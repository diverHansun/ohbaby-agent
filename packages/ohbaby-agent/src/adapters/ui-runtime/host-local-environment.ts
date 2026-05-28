import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionEnvironment } from "../../core/tool-scheduler/index.js";
import {
  AdapterRegistry,
  HostLocalAdapter,
  SandboxManager,
  type SandboxLease,
  type SandboxManagerPort,
} from "../../sandbox/index.js";

export interface HostLocalSandboxManager extends SandboxManagerPort {
  setSessionEnvironment(
    sessionId: string,
    environment: ToolExecutionEnvironment | undefined,
  ): Promise<void>;
}

function normalizeForBoundary(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  const withoutTrailingSeparator =
    resolved.length > root.length ? resolved.replace(/[\\/]+$/u, "") : resolved;
  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

function assertInsideWorkdir(
  workdir: string,
  inputPath: string,
  resolved: string,
): string {
  if (path.isAbsolute(inputPath)) {
    return resolved;
  }

  const normalizedRoot = normalizeForBoundary(workdir);
  const normalizedCandidate = normalizeForBoundary(resolved);
  if (normalizedRoot === normalizedCandidate) {
    return resolved;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

function resolveHostPath(workdir: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workdir, inputPath);
}

function realpathExistingDirectory(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch (nativeError) {
    if (isNotFound(nativeError)) {
      return path.resolve(directory);
    }
    try {
      return realpathSync(directory);
    } catch (error) {
      if (isNotFound(error)) {
        return path.resolve(directory);
      }
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function createHostLocalEnvironment(
  workdir = process.cwd(),
): ToolExecutionEnvironment {
  const root = realpathExistingDirectory(path.resolve(workdir));

  return {
    workdir: root,
    resolvePath(inputPath: string): string {
      return assertInsideWorkdir(
        root,
        inputPath,
        resolveHostPath(root, inputPath),
      );
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const resolved = await fs.realpath(resolveHostPath(root, inputPath));
      return assertInsideWorkdir(root, inputPath, resolved);
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = resolveHostPath(root, inputPath);
      const realParent = await fs.realpath(path.dirname(target));
      const resolved = path.join(realParent, path.basename(target));
      return assertInsideWorkdir(root, inputPath, resolved);
    },
    resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
      return {
        cwd: root,
        kind: "host-local",
      };
    },
  };
}

export function createHostLocalSandboxManager(
  workdir = process.cwd(),
): HostLocalSandboxManager {
  const fallbackWorkdir = createHostLocalEnvironment(workdir).workdir;
  const registry = new AdapterRegistry();
  registry.register(new HostLocalAdapter());
  const manager = new SandboxManager({ adapterRegistry: registry });
  const operations = new Map<string, Promise<void>>();

  function withSessionOperation(
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = operations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.finally(() => {
      if (operations.get(sessionId) === tracked) {
        operations.delete(sessionId);
      }
    });
    operations.set(sessionId, tracked);
    return tracked;
  }

  async function ensureSessionWorkdir(
    sessionId: string,
    nextWorkdir: string,
  ): Promise<void> {
    const resolvedWorkdir = path.resolve(nextWorkdir);
    const existing = manager.getContext(sessionId);
    if (existing && path.resolve(existing.workdir) !== resolvedWorkdir) {
      await manager.destroyContext(sessionId);
    }
    await manager.ensureContext(sessionId, {
      adapterId: "host-local",
      workdir: resolvedWorkdir,
    });
  }

  async function ensureFallback(sessionId: string): Promise<void> {
    if (manager.getContext(sessionId)) {
      return;
    }
    await ensureSessionWorkdir(sessionId, fallbackWorkdir);
  }

  return {
    setSessionEnvironment(sessionId, environment): Promise<void> {
      return withSessionOperation(sessionId, async () => {
        if (!environment) {
          await manager.destroyContext(sessionId);
          return;
        }
        await ensureSessionWorkdir(sessionId, environment.workdir);
      });
    },

    async acquire(sessionId: string): Promise<SandboxLease> {
      const pending = operations.get(sessionId);
      if (pending) {
        await pending;
      }
      await ensureFallback(sessionId);
      return await manager.acquire(sessionId);
    },

    release(lease: SandboxLease): Promise<void> {
      return manager.release(lease);
    },
  };
}
