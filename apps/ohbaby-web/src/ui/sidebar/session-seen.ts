import type { UiGlobalSession, UiRun } from "ohbaby-sdk";
import { serverOrigin } from "./session-pins.js";

/**
 * Which replies this browser has seen, per server (unread dot topic). A
 * session is unread when its latest turn ended after the time recorded for
 * it, or after `since` (first use) when none is recorded. Turn end times come
 * from the server; `seen` only ever stores those, so the browser clock is
 * compared with them only through `since`.
 */
export interface SessionSeenSnapshot {
  /** Epoch ms of first use; older replies count as seen. */
  readonly since: number;
  /** Session id to the turn end time (epoch ms) last seen. */
  readonly seen: Readonly<Record<string, number>>;
}

export interface SessionSeenStore {
  getSnapshot(): SessionSeenSnapshot;
  subscribe(listener: () => void): () => void;
  /** Records a turn end as seen; an older time is ignored. */
  markSeen(id: string, at: number): void;
}

export function globalSessionSeenKey(serverUrl: string | undefined): string {
  return `ohbaby.web.session-seen.v1:${JSON.stringify([serverOrigin(serverUrl)])}`;
}

/** Unread: a turn ended after it was last seen, and the chat is not open. */
export function isUnread(
  session: Pick<UiGlobalSession, "id" | "lastTurnEndedAt">,
  snapshot: SessionSeenSnapshot,
  activeId: string | null | undefined,
): boolean {
  if (session.id === activeId || session.lastTurnEndedAt === undefined)
    return false;
  const ended = Date.parse(session.lastTurnEndedAt);
  return (
    Number.isFinite(ended) &&
    ended > (snapshot.seen[session.id] ?? snapshot.since)
  );
}

/**
 * Epoch ms of the session's latest main turn that succeeded or failed, from
 * its own runs (main turns only, ledger times), or undefined.
 */
export function latestTurnEnd(
  runs: readonly Pick<UiRun, "sessionId" | "outcome" | "endedAt">[],
  sessionId: string | null | undefined,
): number | undefined {
  let latest: number | undefined;
  for (const run of runs) {
    if (run.sessionId !== sessionId || run.endedAt === undefined) continue;
    if (run.outcome !== "succeeded" && run.outcome !== "failed") continue;
    const ended = Date.parse(run.endedAt);
    if (Number.isFinite(ended) && (latest === undefined || ended > latest))
      latest = ended;
  }
  return latest;
}

function parse(raw: string | null): SessionSeenSnapshot | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const { since, seen } = value as { since?: unknown; seen?: unknown };
    if (typeof since !== "number" || !Number.isFinite(since)) return null;
    const entries =
      seen !== null && typeof seen === "object" && !Array.isArray(seen)
        ? Object.entries(seen).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isFinite(entry[1]),
          )
        : [];
    return { since, seen: Object.fromEntries(entries) };
  } catch {
    return null;
  }
}

function createStore(key: string): SessionSeenStore {
  const read = (): SessionSeenSnapshot | null => {
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      return null;
    }
  };
  const write = (next: SessionSeenSnapshot): void => {
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Unwritable storage: this page still remembers what it has seen.
    }
  };
  const stored = read();
  let snapshot: SessionSeenSnapshot = stored ?? { since: Date.now(), seen: {} };
  if (!stored) write(snapshot);
  const listeners = new Set<() => void>();
  const publish = (next: SessionSeenSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== key) return;
    const next = read();
    if (next) publish(next);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0)
          window.removeEventListener("storage", onStorage);
      };
    },
    markSeen: (id, at): void => {
      // Another tab may have written since our last read: merge over it.
      const base = read() ?? snapshot;
      const known = Math.max(base.seen[id] ?? 0, snapshot.seen[id] ?? 0);
      if (at <= known) return;
      const next = {
        since: base.since,
        seen: { ...snapshot.seen, ...base.seen, [id]: at },
      };
      write(next);
      publish(next);
    },
  };
}

const stores = new Map<string, SessionSeenStore>();

/** One store per server for the lifetime of the page. */
export function getSessionSeenStore(
  serverUrl: string | undefined,
): SessionSeenStore {
  const key = globalSessionSeenKey(serverUrl);
  let store = stores.get(key);
  if (!store) {
    store = createStore(key);
    stores.set(key, store);
  }
  return store;
}
