import type {
  SandboxAdapter,
  SandboxAdapterHandle,
  SandboxCapabilities,
  SandboxContext,
  SandboxContextStatus,
} from "./types.js";
import type { TrustedRootRegistry } from "./trusted-roots.js";

export interface InternalSandboxContext {
  readonly contextId: string;
  readonly contextScopeId?: string;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly adapter: SandboxAdapter;
  readonly adapterId: string;
  readonly handle: SandboxAdapterHandle;
  readonly trustedRoots: TrustedRootRegistry;
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
    contextScopeId: context.contextScopeId,
    createdAt: context.createdAt,
    leaseCount: context.leaseCount,
    scopeKey: context.scopeKey,
    sessionId: context.sessionId,
    status: context.status,
    workdir: context.workdir,
  };
}
