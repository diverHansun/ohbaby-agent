// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  readWebNavigationState,
  replaceNavigationHash,
  writeWebNavigationState,
} from "./navigation-state.js";

describe("web navigation state", () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        clear: (): void => {
          values.clear();
        },
        getItem: (key: string): string | null => values.get(key) ?? null,
        key: (index: number): string | null =>
          [...values.keys()][index] ?? null,
        get length(): number {
          return values.size;
        },
        removeItem: (key: string): void => {
          values.delete(key);
        },
        setItem: (key: string, value: string): void => {
          values.set(key, value);
        },
      } satisfies Storage,
    });
    history.replaceState(null, "", "/");
  });

  it("round-trips the last open session and its directory", () => {
    writeWebNavigationState({
      lastSession: { sessionId: "session-a", directory: "/repo/a" },
    });
    expect(readWebNavigationState()).toEqual({
      lastSession: { sessionId: "session-a", directory: "/repo/a" },
    });
    writeWebNavigationState({ lastSession: null });
    expect(readWebNavigationState()).toEqual({ lastSession: null });
  });

  it("reads the v1 selected project and its session once", () => {
    values.set(
      "ohbaby.web.navigation.v1",
      JSON.stringify({
        selectedDirectory: "/repo/a",
        sessionByDirectory: { "/repo/a": "session-a", "/repo/b": "session-b" },
      }),
    );
    expect(readWebNavigationState()).toEqual({
      lastSession: { sessionId: "session-a", directory: "/repo/a" },
    });
    values.set(
      "ohbaby.web.navigation.v1",
      JSON.stringify({ selectedDirectory: "/repo/c", sessionByDirectory: {} }),
    );
    expect(readWebNavigationState()).toEqual({ lastSession: null });
  });

  it("replaces the canonical project and session hash", () => {
    replaceNavigationHash({ directory: "/repo/a", sessionId: "session-a" });
    expect(location.hash).toBe("#directory=%2Frepo%2Fa&session=session-a");
  });

  it("treats an unavailable Node localStorage implementation as empty storage", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {},
    });

    expect(readWebNavigationState()).toEqual({ lastSession: null });
    expect(() => {
      writeWebNavigationState({ lastSession: null });
    }).not.toThrow();
  });
});
