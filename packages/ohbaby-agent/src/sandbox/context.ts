import type {
  SandboxAdapter,
  SandboxAdapterHandle,
  SandboxCapabilities,
  SandboxContext,
  SandboxContextStatus,
} from "./types.js";

export interface InternalSandboxContext {
  readonly contextId: string;
  readonly sessionId: string;
  readonly adapter: SandboxAdapter;
  readonly adapterId: string;
  readonly handle: SandboxAdapterHandle;
  readonly workdir: string;
  readonly capabilities: SandboxCapabilities;
  readonly createdAt: number;
  readonly waiters: (() => void)[];
  leaseCount: number;
  status: SandboxContextStatus;
}

export function freezeCapabilities(
  capabilities: SandboxCapabilities,
): SandboxCapabilities {
  return Object.freeze({ ...capabilities });
}

export function snapshotContext(
  context: InternalSandboxContext,
): SandboxContext {
  return {
    adapterId: context.adapterId,
    capabilities: context.capabilities,
    contextId: context.contextId,
    createdAt: context.createdAt,
    leaseCount: context.leaseCount,
    sessionId: context.sessionId,
    status: context.status,
    workdir: context.workdir,
  };
}
