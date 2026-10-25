export interface StoredComposerDraft {
  readonly clientRequestId?: string;
  readonly pendingText?: string;
  readonly text: string;
}

export interface QueuedEditState {
  readonly status?: "queued" | "retained";
  readonly operationId?: string;
  /** Frozen once sent: an ambiguous result must replay the identical request. */
  readonly retainedSendText?: string;
  readonly leaseLost?: boolean;
  readonly editLeaseId: string;
  readonly expiresAt: string;
  readonly originalDraft: string;
  readonly originalPendingRequestId?: string;
  readonly originalPendingText?: string;
  readonly promptId: string;
}

export interface StoredQueuedEdit extends QueuedEditState {
  readonly editText: string;
  readonly lastActivityAt: number;
}

export function composerDraftKey(scopeKey: string): string {
  return `ohbaby:composer:${scopeKey}`;
}

export function composerLeaseKey(scopeKey: string): string {
  return `ohbaby:composer-lease:${scopeKey}`;
}

export function readSessionValue(key: string): unknown {
  try {
    const value = globalThis.sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as unknown) : null;
  } catch {
    return null;
  }
}

export function writeSessionValue(key: string, value: unknown): void {
  try {
    globalThis.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Draft persistence is a resilience feature; storage denial must not block input.
  }
}

export function removeSessionValue(key: string): void {
  try {
    globalThis.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage denial.
  }
}

const DRAFT_PREFIX = "ohbaby:composer:";
const LEASE_PREFIX = "ohbaby:composer-lease:";
/** Set once per tab so a sent draft is not resurrected from its old key. */
const MIGRATED_KEY = "ohbaby:composer-keys:v2";

/**
 * Moves drafts saved under the pre-redesign `<directory>:<session|new>` scope
 * to the directory-free `<session|new>` scope. A session's draft moves when
 * exactly one directory holds it; the new-chat draft moves only when exactly
 * one directory had one. Edit leases move only for sessions, never into
 * `new`. Old keys stay, an existing new key is never overwritten, and the
 * move runs once per tab. Returns the directory a moved new-chat draft was
 * written in, so the draft can reopen in that project.
 */
export function migrateLegacyComposerKeys(): string | null {
  let draftDirectory: string | null = null;
  try {
    const storage = globalThis.sessionStorage;
    if (storage.getItem(MIGRATED_KEY) !== null) return null;
    storage.setItem(MIGRATED_KEY, "1");
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
    for (const prefix of [DRAFT_PREFIX, LEASE_PREFIX]) {
      const byScope = new Map<string, string[]>();
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const scope = key.slice(prefix.length);
        // The directory may itself contain ":" (Windows), so split at the last one.
        const split = scope.lastIndexOf(":");
        if (split <= 0) continue;
        const target = scope.slice(split + 1);
        if (target.length === 0) continue;
        byScope.set(target, [...(byScope.get(target) ?? []), key]);
      }
      for (const [target, sources] of byScope) {
        if (sources.length !== 1) continue;
        if (prefix === LEASE_PREFIX && target === "new") continue;
        const destination = `${prefix}${target}`;
        if (storage.getItem(destination) !== null) continue;
        const source = sources[0] ?? "";
        const value = storage.getItem(source);
        if (value === null) continue;
        storage.setItem(destination, value);
        if (prefix === DRAFT_PREFIX && target === "new")
          draftDirectory = source.slice(
            DRAFT_PREFIX.length,
            source.lastIndexOf(":"),
          );
      }
    }
  } catch {
    // Unreadable storage: old drafts simply stay where they were.
  }
  return draftDirectory;
}
