import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionEnvironment } from "../../core/tool-scheduler/index.js";
import {
  AdapterRegistry,
  HostLocalAdapter,
  SandboxManager,
  normalizeSandboxScope,
  type SandboxAcquireTarget,
  type SandboxLease,
  type SandboxManagerPort,
  type SandboxScopeInput,
} from "../../sandbox/index.js";

export interface HostLocalSandboxManager extends SandboxManagerPort {
  destroyContext(input: SandboxScopeInput): Promise<void>;
  setSessionWorkdir(sessionId: string, workdir: string): Promise<void>;
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

function isOutsideRelativePath(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function assertInsideWorkdir(
  workdir: string,
  inputPath: string,
  resolved: string,
): string {
  const normalizedRoot = normalizeForBoundary(workdir);
  const normalizedCandidate = normalizeForBoundary(resolved);
  if (normalizedRoot === normalizedCandidate) {
    return resolved;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (isOutsideRelativePath(relative)) {
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
  const sessionWorkdirs = new Map<string, string>();

  function withOperation(
    key: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.finally(() => {
      if (operations.get(key) === tracked) {
        operations.delete(key);
      }
    });
    operations.set(key, tracked);
    return tracked;
  }

  async function waitForSessionOperation(sessionId: string): Promise<void> {
    const pending = operations.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  async function ensureScopedWorkdir(
    input: SandboxScopeInput,
    nextWorkdir: string,
  ): Promise<void> {
    const scope = normalizeSandboxScope(input);
    const resolvedWorkdir = createHostLocalEnvironment(nextWorkdir).workdir;
    const existing = manager.getContext(scope);
    if (existing && path.resolve(existing.workdir) !== resolvedWorkdir) {
      if (existing.leaseCount > 0) {
        throw new Error(
          `Cannot change active sandbox workdir for scope: ${scope.scopeKey}`,
        );
      }
      await manager.destroyContext(scope);
    }
    await manager.ensureContext(scope, {
      adapterId: "host-local",
      workdir: resolvedWorkdir,
    });
  }

  function workdirForAcquire(input: SandboxAcquireTarget): string {
    if (typeof input !== "string" && input.workdir !== undefined) {
      return input.workdir;
    }
    const scope = normalizeSandboxScope(input);
    return sessionWorkdirs.get(scope.sessionId) ?? fallbackWorkdir;
  }

  return {
    destroyContext(input): Promise<void> {
      const scope = normalizeSandboxScope(input);
      return withOperation(scope.scopeKey, async () => {
        await manager.destroyContext(scope);
      });
    },

    setSessionWorkdir(sessionId, workdir): Promise<void> {
      return withOperation(sessionId, async () => {
        const environment = createHostLocalEnvironment(workdir);
        sessionWorkdirs.set(sessionId, environment.workdir);
        await ensureScopedWorkdir({ sessionId }, environment.workdir);
      });
    },

    async acquire(input: SandboxAcquireTarget): Promise<SandboxLease> {
      const scope = normalizeSandboxScope(input);
      await waitForSessionOperation(scope.sessionId);
      await withOperation(scope.scopeKey, async () => {
        await ensureScopedWorkdir(scope, workdirForAcquire(input));
      });
      return await manager.acquire(scope);
    },

    release(lease: SandboxLease): Promise<void> {
      return manager.release(lease);
    },
  };
}
