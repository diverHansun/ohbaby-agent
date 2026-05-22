import fs from "node:fs/promises";
import path from "node:path";
import { containsOrEqual } from "../utils/index.js";
import { SandboxBoundaryError } from "./errors.js";
import type { InternalSandboxContext } from "./context.js";
import type {
  CommandContext,
  CommandContextOptions,
  SandboxLease,
} from "./types.js";

function resolveInputPath(workdir: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workdir, inputPath);
}

function normalizeLexicalForComparison(inputPath: string): string {
  const normalized = path.normalize(path.resolve(inputPath));
  const root = path.parse(normalized).root;
  const withoutTrailingSeparator =
    normalized.length > root.length
      ? normalized.replace(/[\\/]+$/u, "")
      : normalized;

  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

function containsOrEqualLexical(parent: string, child: string): boolean {
  const normalizedParent = normalizeLexicalForComparison(parent);
  const normalizedChild = normalizeLexicalForComparison(child);
  if (normalizedParent === normalizedChild) {
    return true;
  }
  const relative = path.relative(normalizedParent, normalizedChild);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function assertInside(
  workdir: string,
  inputPath: string,
  resolvedPath: string,
): string {
  if (!containsOrEqual(workdir, resolvedPath)) {
    throw new SandboxBoundaryError(inputPath, workdir, resolvedPath);
  }
  return resolvedPath;
}

function assertInsideLexical(
  workdir: string,
  inputPath: string,
  resolvedPath: string,
): string {
  if (!containsOrEqualLexical(workdir, resolvedPath)) {
    throw new SandboxBoundaryError(inputPath, workdir, resolvedPath);
  }
  return resolvedPath;
}

export function createSandboxLease(input: {
  readonly context: InternalSandboxContext;
  readonly leaseId: string;
  readonly release: (leaseId: string) => Promise<void>;
}): SandboxLease {
  let released = false;
  const { context } = input;

  return {
    adapterId: context.adapterId,
    capabilities: context.capabilities,
    contextId: context.contextId,
    leaseId: input.leaseId,
    sessionId: context.sessionId,
    workdir: context.workdir,

    resolvePath(inputPath: string): string {
      const resolvedPath = resolveInputPath(context.workdir, inputPath);
      return assertInsideLexical(context.workdir, inputPath, resolvedPath);
    },

    async resolvePathForExisting(inputPath: string): Promise<string> {
      const target = resolveInputPath(context.workdir, inputPath);
      const resolvedPath = await fs.realpath(target);
      return assertInside(context.workdir, inputPath, resolvedPath);
    },

    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = resolveInputPath(context.workdir, inputPath);
      const parent = path.dirname(target);
      const realParent = await fs.realpath(parent);
      const resolvedPath = path.join(realParent, path.basename(target));
      return assertInside(context.workdir, inputPath, resolvedPath);
    },

    resolveCommandContext(options?: CommandContextOptions): CommandContext {
      return (
        context.adapter.resolveCommandContext?.(context.handle, options) ?? {
          cwd: context.workdir,
          kind: context.adapterId,
        }
      );
    },

    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await input.release(input.leaseId);
    },
  };
}
