import type { UiSessionIndexEntry } from "ohbaby-sdk";

type Pins = Readonly<Record<string, number>>;

interface PinSnapshot {
  readonly pins: Pins;
  readonly error: boolean;
}

interface SessionPinsStore {
  getSnapshot(): PinSnapshot;
  subscribe(listener: () => void): () => void;
  setPinned(id: string, pinned: boolean): void;
}

const stores = new Map<string, SessionPinsStore>();

export function sessionPinsKey(
  serverUrl: string | undefined,
  directory: string,
): string {
  const fallback = window.location.origin;
  let origin = fallback;
  try {
    origin = new URL(
      serverUrl === "" ? fallback : (serverUrl ?? fallback),
      fallback,
    ).origin;
  } catch {
    // An incomplete connection URL must not prevent the sidebar rendering.
  }
  return `ohbaby.web.session-pins.v1:${JSON.stringify([origin, directory])}`;
}

function parsePins(raw: string | null): Pins {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, timestamp]) =>
          typeof timestamp === "number" &&
          Number.isFinite(timestamp) &&
          timestamp > 0,
      ),
    );
  } catch {
    return {};
  }
}

function readPins(key: string, previous: Pins): PinSnapshot {
  try {
    return { pins: parsePins(window.localStorage.getItem(key)), error: false };
  } catch {
    return { pins: previous, error: true };
  }
}

function samePins(left: Pins, right: Pins): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([id, value]) => Object.hasOwn(right, id) && right[id] === value,
    )
  );
}

function createStore(key: string): SessionPinsStore {
  let snapshot = readPins(key, {});
  const pending = new Map<string, number | null>();
  const listeners = new Set<() => void>();

  const publish = (next: PinSnapshot): void => {
    if (next.error === snapshot.error && samePins(next.pins, snapshot.pins)) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const refresh = (): void => {
    if (pending.size === 0) publish(readPins(key, snapshot.pins));
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== key) return;
    // Read actual storage, including clear(), so delayed events cannot roll
    // back a newer value. Unsaved local edits take priority until a write works.
    refresh();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        window.addEventListener("storage", onStorage);
        refresh();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          window.removeEventListener("storage", onStorage);
        }
      };
    },
    setPinned: (id, pinned): void => {
      const base = readPins(key, snapshot.pins);
      const merged = new Map(Object.entries(base.pins));
      // Replay only this page's unsaved edits over the latest readable base.
      // Unknown pins from another tab survive recovery from failed reads.
      for (const [pendingId, timestamp] of pending) {
        if (timestamp === null) merged.delete(pendingId);
        else merged.set(pendingId, timestamp);
      }
      if (pinned) {
        const latest = [...merged.values()].reduce(
          (max, value) => Math.max(max, value),
          0,
        );
        const timestamp = Math.max(Date.now(), latest + 1);
        merged.set(id, timestamp);
        pending.set(id, timestamp);
      } else {
        merged.delete(id);
        pending.set(id, null);
      }
      const pins = Object.fromEntries(merged);
      if (base.error) {
        // Writing an unreadable base could erase preferences we never saw.
        publish({ pins, error: true });
        return;
      }
      let error = false;
      try {
        window.localStorage.setItem(key, JSON.stringify(pins));
        pending.clear();
      } catch {
        error = true;
      }
      publish({ pins, error });
    },
  };
}

/** Keep failed writes across project unmounts for the lifetime of this page. */
export function getSessionPinsStore(key: string): SessionPinsStore {
  let store = stores.get(key);
  if (!store) {
    store = createStore(key);
    stores.set(key, store);
  }
  return store;
}

export function sortPinnedSessions(
  sessions: readonly UiSessionIndexEntry[],
  pins: Pins,
): UiSessionIndexEntry[] {
  return [...sessions].sort((left, right) => {
    const leftPin = Object.hasOwn(pins, left.id) ? (pins[left.id] ?? 0) : 0;
    const rightPin = Object.hasOwn(pins, right.id) ? (pins[right.id] ?? 0) : 0;
    if (leftPin || rightPin) {
      return rightPin - leftPin || left.id.localeCompare(right.id);
    }
    return (
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.id.localeCompare(right.id)
    );
  });
}
