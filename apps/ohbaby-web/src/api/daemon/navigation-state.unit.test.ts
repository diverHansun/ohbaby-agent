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

  it("round-trips the selected project and per-project sessions", () => {
    writeWebNavigationState({
      selectedDirectory: "/repo/a",
      sessionByDirectory: { "/repo/a": "session-a" },
    });
    expect(readWebNavigationState()).toEqual({
      selectedDirectory: "/repo/a",
      sessionByDirectory: { "/repo/a": "session-a" },
    });
  });

  it("replaces the canonical project and session hash", () => {
    replaceNavigationHash({ directory: "/repo/a", sessionId: "session-a" });
    expect(location.hash).toBe("#directory=%2Frepo%2Fa&session=session-a");
  });
});
