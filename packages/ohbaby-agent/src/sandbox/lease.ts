import fs from "node:fs/promises";
import path from "node:path";
import { canonicalizePathTarget } from "../utils/path-canonicalize.js";
import { SandboxBoundaryError } from "./errors.js";
import { containsOrEqualPath } from "./boundary.js";
import type { InternalSandboxContext } from "./context.js";
import { preflightSandboxCommand } from "./preflight.js";
import type {
  CommandContext,
  CommandContextOptions,
  PreflightResult,
  SandboxLease,
} from "./types.js";

function resolveInputPath(workdir: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workdir, inputPath);
}

function trustedRootPaths(context: InternalSandboxContext): readonly string[] {
  return context.trustedRoots.snapshot().map((root) => root.path);
}

function assertTrusted(
  context: InternalSandboxContext,
  inputPath: string,
  resolvedPath: string,
): string {
  if (!context.trustedRoots.contains(resolvedPath)) {
    throw new SandboxBoundaryError(inputPath, context.workdir, resolvedPath);
  }
  return resolvedPath;
}

function assertTrustedLexical(
  context: InternalSandboxContext,
  inputPath: string,
  resolvedPath: string,
): string {
  const trustedRoots = trustedRootPaths(context);
  const isTrusted = trustedRoots.some((root) =>
    containsOrEqualPath(root, resolvedPath),
  );
  if (!isTrusted) {
    throw new SandboxBoundaryError(inputPath, context.workdir, resolvedPath);
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
    contextScopeId: context.contextScopeId,
    leaseId: input.leaseId,
    scopeKey: context.scopeKey,
    sessionId: context.sessionId,
    workdir: context.workdir,

    containsTrustedPath(absolutePath: string): boolean {
      return context.trustedRoots.contains(path.resolve(absolutePath));
    },

    resolvePath(inputPath: string): string {
      const resolvedPath = resolveInputPath(context.workdir, inputPath);
      return assertTrustedLexical(context, inputPath, resolvedPath);
    },

    async resolvePathForExisting(inputPath: string): Promise<string> {
      const target = resolveInputPath(context.workdir, inputPath);
      const resolvedPath = await fs.realpath(target);
      return assertTrusted(context, inputPath, resolvedPath);
    },

    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = resolveInputPath(context.workdir, inputPath);
      const resolvedPath = await canonicalizePathTarget(target);
      return assertTrusted(context, inputPath, resolvedPath);
    },

    resolveCommandContext(options?: CommandContextOptions): CommandContext {
      return (
        context.adapter.resolveCommandContext?.(context.handle, options) ?? {
          cwd: context.workdir,
          kind: context.adapterId,
        }
      );
    },

    preflight(command, shellKind): Promise<PreflightResult> {
      return preflightSandboxCommand({
        command,
        shellKind,
        trustedRoots: trustedRootPaths(context),
        workdir: context.workdir,
      });
    },

    trustPath(input): ReturnType<SandboxLease["trustPath"]> {
      return context.trustedRoots.add(input);
    },

    trustedRoots(): ReturnType<SandboxLease["trustedRoots"]> {
      return context.trustedRoots.snapshot();
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
