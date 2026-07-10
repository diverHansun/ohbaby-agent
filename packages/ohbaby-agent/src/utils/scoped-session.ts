export interface ScopedSessionIdentity {
  readonly contextScopeId?: string;
  readonly sessionId: string;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Canonical in-memory key for state that belongs to a session or one of its
 * isolated context scopes. It is intentionally not a database key.
 */
export function scopedSessionKey(input: ScopedSessionIdentity): string {
  const sessionId = encodePart(input.sessionId);
  return input.contextScopeId === undefined
    ? sessionId
    : `${sessionId}::${encodePart(input.contextScopeId)}`;
}

export function isScopedSessionKeyForSession(
  key: string,
  sessionId: string,
): boolean {
  const sessionKey = scopedSessionKey({ sessionId });
  return key === sessionKey || key.startsWith(`${sessionKey}::`);
}
