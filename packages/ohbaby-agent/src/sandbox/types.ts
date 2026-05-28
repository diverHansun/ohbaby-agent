import type {
  ShellAnalysisResult,
  ShellCommandAnalysis,
  ShellKind,
} from "../shell/index.js";
import type { TrustedRoot, TrustedRootKind } from "./trusted-roots.js";

export type SandboxIsolation = "none" | "worktree" | "container" | "remote";
export type SandboxContextStatus = "active" | "destroying" | "destroyed";
export type SandboxAdapterId = string;
export type SandboxPathBoundary = "inside" | "outside";

export type DenylistReason =
  | "ssh-key-dir"
  | "aws-credentials"
  | "gnupg-dir"
  | "env-file"
  | "private-key"
  | "shell-rc";

export type PreflightCommand = ShellCommandAnalysis;

export interface PreflightInternalPath {
  readonly original: string;
  readonly absolutePath: string;
}

export interface PreflightExternalPath {
  readonly original: string;
  readonly absolutePath: string;
  readonly askPattern: string;
}

export interface PreflightDenylistHit {
  readonly original: string;
  readonly absolutePath: string;
  readonly reason: DenylistReason;
}

export interface PreflightSensitivePath {
  readonly original: string;
  readonly absolutePath: string;
  readonly askPattern: string;
  readonly reason: DenylistReason;
}

export interface PreflightResult {
  readonly shellKind: ShellKind;
  readonly commands: readonly PreflightCommand[];
  readonly internalPaths: readonly PreflightInternalPath[];
  readonly externalPaths: readonly PreflightExternalPath[];
  readonly denylistHits: readonly PreflightDenylistHit[];
  readonly sensitivePaths: readonly PreflightSensitivePath[];
  readonly overallDanger: PreflightCommand["danger"];
  readonly parseError?: string;
}

export interface SandboxPreflightInput {
  readonly command: string;
  readonly shellKind: ShellKind;
  readonly trustedRoots?: readonly string[];
  readonly workdir: string;
}

export interface SandboxShellAnalysisPreflightInput {
  readonly shell: ShellAnalysisResult;
  readonly trustedRoots?: readonly string[];
  readonly workdir: string;
}

export interface SandboxCapabilities {
  readonly isolation: SandboxIsolation;
  readonly canExecCommands: boolean;
  readonly supportsGit: boolean;
  readonly readOnly: boolean;
}

export interface CommandContext {
  readonly kind: SandboxAdapterId;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly commandPrefix?: readonly string[];
}

export interface CommandContextOptions {
  readonly fileAccess?: "none" | "workspace-ro" | "workspace-rw";
}

export interface TrustPathInput {
  readonly kind: TrustedRootKind;
  readonly path: string;
  readonly source?: string;
}

export interface SandboxCreateOptions {
  readonly sessionId: string;
  readonly workdir: string;
}

export interface SandboxAdapterHandle {
  readonly workdir: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SandboxAdapter {
  readonly id: SandboxAdapterId;
  getCapabilities(handle?: SandboxAdapterHandle): SandboxCapabilities;
  create(options: SandboxCreateOptions): Promise<SandboxAdapterHandle>;
  destroy(handle: SandboxAdapterHandle): Promise<void>;
  resolveCommandContext?(
    handle: SandboxAdapterHandle,
    options?: CommandContextOptions,
  ): CommandContext;
}

export interface SandboxContext {
  readonly contextId: string;
  readonly sessionId: string;
  readonly adapterId: SandboxAdapterId;
  readonly workdir: string;
  readonly capabilities: SandboxCapabilities;
  readonly createdAt: number;
  readonly leaseCount: number;
  readonly status: SandboxContextStatus;
}

export interface SandboxLease {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly contextId: string;
  readonly adapterId: SandboxAdapterId;
  readonly workdir: string;
  readonly capabilities: SandboxCapabilities;
  containsTrustedPath(absolutePath: string): boolean;
  resolvePath(inputPath: string): string;
  resolvePathForExisting(inputPath: string): Promise<string>;
  resolvePathForWrite(inputPath: string): Promise<string>;
  resolveCommandContext(options?: CommandContextOptions): CommandContext;
  preflight(command: string, shellKind: ShellKind): Promise<PreflightResult>;
  trustPath(input: TrustPathInput): Promise<TrustedRoot>;
  trustedRoots(): readonly TrustedRoot[];
  release(): Promise<void>;
}

export interface SandboxManagerPort {
  acquire(sessionId: string): Promise<SandboxLease>;
  release(lease: SandboxLease): Promise<void>;
}

export interface SandboxManagerOptions {
  readonly adapterRegistry: {
    get(adapterId: SandboxAdapterId): SandboxAdapter | undefined;
  };
  readonly drainTimeoutMs?: number;
  readonly now?: () => number;
  readonly createContextId?: () => string;
  readonly createLeaseId?: () => string;
}

export interface CreateContextOptions {
  readonly adapterId?: SandboxAdapterId;
  readonly workdir: string;
}
