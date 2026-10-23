// @vitest-environment jsdom
import type { UiSessionIndexEntry } from "ohbaby-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pinsModule: typeof import("./session-pins.js");
let storage: Storage;
const values = new Map<string, string>();

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  values.clear();
  storage = {
    clear: (): void => {
      values.clear();
    },
    getItem: (key): string | null => values.get(key) ?? null,
    key: (index): string | null => [...values.keys()][index] ?? null,
    get length(): number {
      return values.size;
    },
    removeItem: (key): void => {
      values.delete(key);
    },
    setItem: (key, value): void => {
      values.set(key, value);
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  pinsModule = await import("./session-pins.js");
});

function session(id: string, updatedAt = "2026-09-01"): UiSessionIndexEntry {
  return { id, title: id, createdAt: "2026-08-01", updatedAt };
}

describe("session pin preferences", () => {
  it("isolates server origins and project paths without persisting URL credentials", () => {
    const { sessionPinsKey: key, getSessionPinsStore: get } = pinsModule;
    const first = key(
      "http://user:secret@localhost:3000/api?token=secret",
      "/a",
    );
    expect(first).toBe(key("http://localhost:3000/", "/a"));
    expect(first).not.toContain("secret");
    expect(key(undefined, "/a")).toBe(key(window.location.origin, "/a"));
    expect(first).not.toBe(key("http://localhost:3001", "/a"));
    get(first).setPinned("a", true);
    expect(Object.keys(get(first).getSnapshot().pins)).toEqual(["a"]);
    expect(get(key("http://localhost:3000", "/b")).getSnapshot().pins).toEqual(
      {},
    );
    expect(get(key("http://localhost:3001", "/a")).getSnapshot().pins).toEqual(
      {},
    );
  });

  it("keeps newest pins first even in one millisecond without mutating sessions", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const store = pinsModule.getSessionPinsStore("order");
    store.setPinned("a", true);
    store.setPinned("b", true);
    const input = Object.freeze([
      session("a", "2026-09-30"),
      session("b"),
      session("c"),
    ]);
    expect(store.getSnapshot().pins).toEqual({ a: 100, b: 101 });
    expect(
      pinsModule
        .sortPinnedSessions(input, store.getSnapshot().pins)
        .map((s) => s.id),
    ).toEqual(["b", "a", "c"]);
    expect(input.map((s) => s.id)).toEqual(["a", "b", "c"]);
    store.setPinned("a", false);
    store.setPinned("a", true);
    expect(
      pinsModule
        .sortPinnedSessions(input, store.getSnapshot().pins)
        .map((s) => s.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("sorts ordinary sessions by update time and breaks ties by ID", () => {
    const input = [session("b"), session("c", "2026-09-30"), session("a")];
    expect(pinsModule.sortPinnedSessions(input, {}).map((s) => s.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(
      pinsModule.sortPinnedSessions(input, { b: 20, a: 20 }).map((s) => s.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("restores persisted preferences in a fresh module", async () => {
    pinsModule.getSessionPinsStore("refresh").setPinned("saved", true);
    vi.resetModules();
    const fresh = await import("./session-pins.js");
    expect(
      Object.keys(fresh.getSessionPinsStore("refresh").getSnapshot().pins),
    ).toEqual(["saved"]);
  });

  it("sorts ordinary sessions by actual instants across timezone offsets", () => {
    const input = [
      session("earlier", "2026-09-30T10:00:00+08:00"),
      session("later", "2026-09-30T04:00:00Z"),
    ];
    expect(pinsModule.sortPinnedSessions(input, {}).map((s) => s.id)).toEqual([
      "later",
      "earlier",
    ]);
  });

  it.each(["[]", "null", "123", '"text"', "{bad"])(
    "recovers malformed storage %s",
    (value) => {
      storage.setItem("invalid", value);
      const store = pinsModule.getSessionPinsStore("invalid");
      expect(store.getSnapshot()).toEqual({ pins: {}, error: false });
      store.setPinned("good", true);
      expect(
        Object.keys(
          JSON.parse(storage.getItem("invalid") ?? "null") as Record<
            string,
            number
          >,
        ),
      ).toEqual(["good"]);
    },
  );

  it("filters invalid timestamps and handles prototype-shaped IDs as own properties", () => {
    storage.setItem(
      "safe",
      '{"good":12,"zero":0,"negative":-1,"string":"12","infinite":1e999,"__proto__":20,"constructor":21}',
    );
    const store = pinsModule.getSessionPinsStore("safe");
    expect(Object.keys(store.getSnapshot().pins).sort()).toEqual([
      "__proto__",
      "constructor",
      "good",
    ]);
    store.setPinned("__proto__", false);
    store.setPinned("toString", true);
    expect(Object.hasOwn(store.getSnapshot().pins, "__proto__")).toBe(false);
    expect(Object.hasOwn(store.getSnapshot().pins, "toString")).toBe(true);
    store.setPinned("__proto__", true);
    expect(Object.hasOwn(store.getSnapshot().pins, "__proto__")).toBe(true);
    expect(
      pinsModule
        .sortPinnedSessions(
          [session("constructor"), session("z", "2026-09-30")],
          {},
        )
        .map((s) => s.id),
    ).toEqual(["z", "constructor"]);
  });

  it("reads newer persisted pins before a clean write", () => {
    const store = pinsModule.getSessionPinsStore("fresh");
    storage.setItem("fresh", '{"other-tab":20}');
    store.setPinned("local", true);
    expect(Object.keys(store.getSnapshot().pins)).toEqual([
      "other-tab",
      "local",
    ]);
  });

  it("preserves consecutive failed writes and project returns, then saves all changes on recovery", () => {
    storage.setItem("a", '{"old":1}');
    const store = pinsModule.getSessionPinsStore("a");
    const stop = store.subscribe(vi.fn());
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    store.setPinned("first", true);
    store.setPinned("second", true);
    store.setPinned("old", false);
    pinsModule.getSessionPinsStore("b").setPinned("unrelated", true);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "a", newValue: '{"old":1}' }),
    );
    expect(pinsModule.getSessionPinsStore("a")).toBe(store);
    expect(Object.keys(store.getSnapshot().pins)).toEqual(["first", "second"]);
    expect(store.getSnapshot().error).toBe(true);
    write.mockRestore();
    store.setPinned("third", true);
    expect(
      Object.keys(
        JSON.parse(storage.getItem("a") ?? "null") as Record<string, number>,
      ),
    ).toEqual(["first", "second", "third"]);
    expect(store.getSnapshot().error).toBe(false);
    stop();
  });

  it("continues in memory when reads fail and retains unsaved edits", () => {
    const read = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const store = pinsModule.getSessionPinsStore("blocked");
    expect(store.getSnapshot().error).toBe(true);
    store.setPinned("a", true);
    read.mockRestore();
    store.setPinned("b", true);
    expect(Object.keys(store.getSnapshot().pins)).toEqual(["a", "b"]);
  });

  it("does not overwrite unreadable stored pins and merges local edits when reading recovers", () => {
    storage.setItem("read-recovery", '{"unknown":10,"remove-later":11}');
    const read = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("temporarily unreadable");
    });
    const store = pinsModule.getSessionPinsStore("read-recovery");
    store.setPinned("local-a", true);
    store.setPinned("remove-later", false);
    expect(store.getSnapshot().error).toBe(true);
    expect(values.get("read-recovery")).toBe(
      '{"unknown":10,"remove-later":11}',
    );
    read.mockRestore();
    store.setPinned("local-b", true);
    expect(Object.keys(store.getSnapshot().pins)).toEqual([
      "unknown",
      "local-a",
      "local-b",
    ]);
    expect(store.getSnapshot().error).toBe(false);
    expect(JSON.parse(storage.getItem("read-recovery") ?? "null")).toEqual(
      store.getSnapshot().pins,
    );
  });

  it("syncs external storage changes, clears, and unsubscribe without unstable snapshots", () => {
    const store = pinsModule.getSessionPinsStore("sync");
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    const seen: string[][] = [];
    const stop = store.subscribe(() => {
      seen.push(Object.keys(store.getSnapshot().pins));
    });
    storage.setItem("sync", '{"external":10}');
    window.dispatchEvent(
      new StorageEvent("storage", { key: "sync", newValue: '{"external":10}' }),
    );
    expect(store.getSnapshot().pins).toEqual({ external: 10 });
    storage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(store.getSnapshot().pins).toEqual({});
    stop();
    store.setPinned("after", true);
    expect(seen).toEqual([["external"], []]);
  });
});
