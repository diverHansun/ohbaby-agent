// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionSeenStore,
  globalSessionSeenKey,
  isUnread,
  latestTurnEnd,
  type SessionSeenSnapshot,
} from "./session-seen.js";

let serial = 0;
/** Stores are cached per server for the page, so each test uses its own. */
function freshServer(): string {
  serial += 1;
  return `http://seen-${String(serial)}.test`;
}

const ended = (ms: number): string => new Date(ms).toISOString();

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("isUnread", () => {
  const snapshot: SessionSeenSnapshot = { since: 1_000, seen: { b: 5_000 } };

  it("compares a turn end with the seen time, else with first use", () => {
    expect(
      isUnread({ id: "a", lastTurnEndedAt: ended(900) }, snapshot, null),
    ).toBe(false);
    expect(
      isUnread({ id: "a", lastTurnEndedAt: ended(1_001) }, snapshot, null),
    ).toBe(true);
    expect(
      isUnread({ id: "b", lastTurnEndedAt: ended(5_000) }, snapshot, null),
    ).toBe(false);
    expect(
      isUnread({ id: "b", lastTurnEndedAt: ended(5_001) }, snapshot, null),
    ).toBe(true);
  });

  it("never marks the open chat or a chat without a finished turn", () => {
    expect(
      isUnread({ id: "b", lastTurnEndedAt: ended(9_000) }, snapshot, "b"),
    ).toBe(false);
    expect(isUnread({ id: "c" }, snapshot, null)).toBe(false);
    expect(
      isUnread({ id: "c", lastTurnEndedAt: "not a time" }, snapshot, null),
    ).toBe(false);
  });
});

describe("latestTurnEnd", () => {
  it("takes the session's latest succeeded or failed run", () => {
    const runs = [
      { sessionId: "a", outcome: "succeeded", endedAt: ended(10) },
      { sessionId: "a", outcome: "failed", endedAt: ended(30) },
      { sessionId: "a", outcome: "interrupted", endedAt: ended(50) },
      { sessionId: "a", outcome: "cancelled", endedAt: ended(60) },
      { sessionId: "a" },
      { sessionId: "b", outcome: "succeeded", endedAt: ended(90) },
    ] as const;
    expect(latestTurnEnd(runs, "a")).toBe(30);
    expect(latestTurnEnd(runs, "c")).toBeUndefined();
    expect(latestTurnEnd(runs, null)).toBeUndefined();
  });
});

describe("getSessionSeenStore", () => {
  it("records first use once and keeps it", () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const server = freshServer();
    expect(getSessionSeenStore(server).getSnapshot()).toEqual({
      since: 42,
      seen: {},
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(globalSessionSeenKey(server)) ?? "",
      ),
    ).toEqual({
      since: 42,
      seen: {},
    });
  });

  it("reads what an earlier page stored", () => {
    const server = freshServer();
    window.localStorage.setItem(
      globalSessionSeenKey(server),
      JSON.stringify({ since: 7, seen: { a: 9, bad: "x" } }),
    );
    expect(getSessionSeenStore(server).getSnapshot()).toEqual({
      since: 7,
      seen: { a: 9 },
    });
  });

  it("only moves a seen time forward", () => {
    const store = getSessionSeenStore(freshServer());
    const listener = vi.fn();
    store.subscribe(listener);
    store.markSeen("a", 10);
    expect(store.getSnapshot().seen).toEqual({ a: 10 });
    expect(listener).toHaveBeenCalledTimes(1);
    store.markSeen("a", 5);
    store.markSeen("a", 10);
    expect(store.getSnapshot().seen).toEqual({ a: 10 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("follows another tab's writes", () => {
    const server = freshServer();
    const key = globalSessionSeenKey(server);
    const store = getSessionSeenStore(server);
    const listener = vi.fn();
    store.subscribe(listener);
    const since = store.getSnapshot().since;
    window.localStorage.setItem(
      key,
      JSON.stringify({ since, seen: { a: 99 } }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(store.getSnapshot().seen).toEqual({ a: 99 });
    expect(listener).toHaveBeenCalledTimes(1);
    // A write here keeps the other tab's entries.
    store.markSeen("b", 3);
    const written = JSON.parse(window.localStorage.getItem(key) ?? "") as {
      seen: Record<string, number>;
    };
    expect(written.seen).toEqual({
      a: 99,
      b: 3,
    });
  });

  it("keeps working in memory when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const store = getSessionSeenStore(freshServer());
    store.markSeen("a", 10);
    expect(store.getSnapshot().seen).toEqual({ a: 10 });
  });
});
