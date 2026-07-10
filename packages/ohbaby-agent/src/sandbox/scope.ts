import type { SandboxScopeIdentity, SandboxScopeInput } from "./types.js";
import { scopedSessionKey } from "../utils/scoped-session.js";

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
  return scopedSessionKey(input);
}

function encodeScopePart(value: string): string {
  return encodeURIComponent(value);
}
