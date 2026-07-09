export { AdapterRegistry } from "./adapter-registry.js";
export {
  SandboxAdapterError,
  SandboxBoundaryError,
  SandboxContextAlreadyExistsError,
  SandboxContextNotFoundError,
} from "./errors.js";
export { SandboxManager } from "./manager.js";
export { normalizeSandboxScope, sandboxScopeKey } from "./scope.js";
export { HostLocalAdapter } from "./adapters/host-local.js";
export {
  classifySandboxPath,
  containsOrEqualPath,
  containsTrustedPath,
} from "./boundary.js";
export { classifyDenylistedPath, classifySensitivePath } from "./denylist.js";
export { resolveSandboxPathArg } from "./paths.js";
export {
  preflightSandboxCommand,
  preflightSandboxShellAnalysis,
} from "./preflight.js";
export type {
  CommandContext,
  CommandContextOptions,
  CreateContextOptions,
  DenylistReason,
  PreflightCommand,
  PreflightDenylistHit,
  PreflightExternalPath,
  PreflightInternalPath,
  PreflightResult,
  PreflightSensitivePath,
  SandboxAdapter,
  SandboxAdapterHandle,
  SandboxAdapterId,
  SandboxAcquireInput,
  SandboxAcquireTarget,
  SandboxCapabilities,
  SandboxContext,
  SandboxContextStatus,
  SandboxCreateOptions,
  SandboxIsolation,
  SandboxLease,
  SandboxManagerPort,
  SandboxManagerOptions,
  SandboxPathBoundary,
  SandboxPreflightInput,
  SandboxShellAnalysisPreflightInput,
  SandboxScopeIdentity,
  SandboxScopeInput,
  TrustPathInput,
} from "./types.js";
export type { NormalizedSandboxScope } from "./scope.js";
export type { TrustedRoot, TrustedRootKind } from "./trusted-roots.js";
