import type {
  SandboxScopeIdentity,
  SandboxScopeInput,
} from "./types.js";

export interface NormalizedSandboxScope extends SandboxScopeIdentity {
  readonly scopeKey: string;
}

export function normalizeSandboxScope(
  input: SandboxScopeInput,
): NormalizedSandboxScope {
  if (typeof input === "string") {
    return {
      scopeKey: input,
      sessionId: input,
    };
  }

  return {
    contextScopeId: input.contextScopeId,
    scopeKey: sandboxScopeKey(input),
    sessionId: input.sessionId,
  };
}

export function sandboxScopeKey(input: SandboxScopeIdentity): string {
  return input.contextScopeId === undefined
    ? input.sessionId
    : `${input.sessionId}::${input.contextScopeId}`;
}
