import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShimmerText,
  computeShimmerSegments,
  shimmerCycleLength,
} from "./shimmer-text.js";

const previousNoAnimation = process.env.OHBABY_TUI_NO_ANIM;
const previousActEnvironment = (
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  if (previousNoAnimation === undefined) {
    delete process.env.OHBABY_TUI_NO_ANIM;
  } else {
    process.env.OHBABY_TUI_NO_ANIM = previousNoAnimation;
  }
});

describe("computeShimmerSegments", () => {
  it("reassembles the original text at every tick", () => {
    const text = "abcdef";
    for (let tick = 0; tick < shimmerCycleLength(text); tick += 1) {
      const { before, shimmer, after } = computeShimmerSegments(text, tick);
      expect(before + shimmer + after).toBe(text);
    }
  });

  it("advances the highlighted window as the tick increases", () => {
    const text = "abcdef";
    const first = computeShimmerSegments(text, 1);
    const second = computeShimmerSegments(text, 3);
    expect(first.before.length).toBeLessThan(second.before.length);
    expect(first.shimmer).not.toBe("");
    expect(second.shimmer).not.toBe("");
  });

  it("leaves no highlight during the idle gap past the end", () => {
    const text = "abc";
    const past = computeShimmerSegments(text, text.length + 2);
    expect(past.shimmer).toBe("");
    expect(past.before).toBe(text);
  });
});

describe("ShimmerText", () => {
  it("renders the phrase flat without a timer when animation is disabled", () => {
    process.env.OHBABY_TUI_NO_ANIM = "1";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let app: ReturnType<typeof render> | undefined;

    act(() => {
      app = render(<ShimmerText text="Igniting the cosmo" />);
    });

    expect(app?.lastFrame()).toContain("Igniting the cosmo");
    expect(setIntervalSpy).not.toHaveBeenCalled();
    act(() => {
      app?.unmount();
    });
  });

  it("starts a sweep timer when animation is enabled", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let app: ReturnType<typeof render> | undefined;

    act(() => {
      app = render(<ShimmerText text="Igniting the cosmo" />);
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(80);
    });
    // Text content is stable across ticks; only the highlight colour moves.
    expect(app?.lastFrame()).toContain("Igniting the cosmo");

    act(() => {
      app?.unmount();
    });
  });
});
