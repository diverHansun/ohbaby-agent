// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDayClock } from "./use-day-clock.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let seen: number[] = [];
function Probe(): null {
  seen.push(useDayClock());
  return null;
}

let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 24, 23, 59, 30));
  seen = [];
  root = createRoot(document.createElement("div"));
  act(() => {
    root.render(<Probe />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  vi.useRealTimers();
});

const day = (): number => new Date(seen.at(-1) ?? 0).getDate();

describe("useDayClock (message time 04 D)", () => {
  it("D-1 moves on after each local midnight", () => {
    expect(day()).toBe(24);
    act(() => {
      vi.advanceTimersByTime(32_000);
    });
    expect(day()).toBe(25);
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(day()).toBe(26);
  });

  it("D-2 stays put within a day", () => {
    const first = seen.at(-1);
    act(() => {
      vi.setSystemTime(new Date(2026, 10, 24, 23, 59, 50));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(seen.at(-1)).toBe(first);
  });

  it("D-3 catches up when the page comes back after midnight", () => {
    act(() => {
      // The computer slept: the clock moved, the timer has not fired.
      vi.setSystemTime(new Date(2026, 10, 25, 8, 0));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(day()).toBe(25);
  });

  it("D-4 clears its timer when unmounted", () => {
    act(() => {
      root.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(document.createElement("div"));
  });
});
