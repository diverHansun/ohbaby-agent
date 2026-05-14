export type SandboxIsolation = "none" | "worktree" | "container" | "remote";
export type SandboxContextStatus = "active" | "destroying" | "destroyed";
export type SandboxAdapterId = string;

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
  resolvePath(inputPath: string): string;
  resolvePathForExisting(inputPath: string): Promise<string>;
  resolvePathForWrite(inputPath: string): Promise<string>;
  resolveCommandContext(options?: CommandContextOptions): CommandContext;
  release(): Promise<void>;
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
