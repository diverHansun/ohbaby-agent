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
      scopeKey: encodeScopePart(input),
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
  const encodedSessionId = encodeScopePart(input.sessionId);
  return input.contextScopeId === undefined
    ? encodedSessionId
    : `${encodedSessionId}::${encodeScopePart(input.contextScopeId)}`;
}

function encodeScopePart(value: string): string {
  return encodeURIComponent(value);
}
