export { AdapterRegistry } from "./adapter-registry.js";
export {
  SandboxAdapterError,
  SandboxBoundaryError,
  SandboxContextAlreadyExistsError,
  SandboxContextNotFoundError,
} from "./errors.js";
export { SandboxManager } from "./manager.js";
export { HostLocalAdapter } from "./adapters/host-local.js";
export { classifySandboxPath, containsOrEqualPath } from "./boundary.js";
export { classifyDenylistedPath } from "./denylist.js";
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
  SandboxAdapter,
  SandboxAdapterHandle,
  SandboxAdapterId,
  SandboxCapabilities,
  SandboxContext,
  SandboxContextStatus,
  SandboxCreateOptions,
  SandboxIsolation,
  SandboxLease,
  SandboxManagerOptions,
  SandboxPathBoundary,
  SandboxPreflightInput,
  SandboxShellAnalysisPreflightInput,
} from "./types.js";
