import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionEnvironment } from "../../core/tool-scheduler/index.js";
import type {
  SandboxLease,
  SandboxManager,
} from "../../runtime/run-manager/index.js";

export interface HostLocalSandboxManager extends SandboxManager {
  setSessionEnvironment(
    sessionId: string,
    environment: ToolExecutionEnvironment | undefined,
  ): void;
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

function toSandboxLease(
  environment: ToolExecutionEnvironment,
  sessionId: string,
): SandboxLease {
  return {
    id: `host-local_${sessionId}`,
    resolveCommandContext: environment.resolveCommandContext.bind(environment),
    resolvePath: environment.resolvePath.bind(environment),
    resolvePathForExisting:
      environment.resolvePathForExisting.bind(environment),
    resolvePathForWrite: environment.resolvePathForWrite.bind(environment),
    workdir: environment.workdir,
  };
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
  const fallbackEnvironment = createHostLocalEnvironment(workdir);
  const sessionEnvironments = new Map<string, ToolExecutionEnvironment>();

  return {
    setSessionEnvironment(sessionId, environment): void {
      if (environment) {
        sessionEnvironments.set(sessionId, environment);
        return;
      }
      sessionEnvironments.delete(sessionId);
    },

    acquire(sessionId: string): Promise<SandboxLease> {
      const environment =
        sessionEnvironments.get(sessionId) ?? fallbackEnvironment;
      return Promise.resolve(toSandboxLease(environment, sessionId));
    },

    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}
