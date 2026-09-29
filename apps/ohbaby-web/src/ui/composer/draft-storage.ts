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
