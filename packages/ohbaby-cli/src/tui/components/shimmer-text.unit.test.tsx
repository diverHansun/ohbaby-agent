import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PULSE_FRAMES,
  SHIMMER_GAP,
  SHIMMER_INTERVAL_MS,
  ShimmerText,
  computeShimmerSpans,
  mixHex,
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

describe("computeShimmerSpans", () => {
  it("reassembles the original text at every tick", () => {
    const text = "abcdefghijklmnop";
    for (let tick = 0; tick < shimmerCycleLength(text); tick += 1) {
      const spans = computeShimmerSpans(text, tick);
      expect(spans.map((span) => span.text).join("")).toBe(text);
      for (const span of spans) {
        expect(span.intensity).toBeGreaterThanOrEqual(0);
        expect(span.intensity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("sweeps a soft highlight left to right with graded edges", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const peakAt = (tick: number): number => {
      let offset = 0;
      let best = { offset: -1, intensity: -1 };
      for (const span of computeShimmerSpans(text, tick)) {
        if (span.intensity > best.intensity)
          best = { offset, intensity: span.intensity };
        offset += span.text.length;
      }
      return best.offset;
    };
    expect(peakAt(4)).toBeLessThan(peakAt(8));
    const levels = new Set(
      computeShimmerSpans(text, 8).map((span) => span.intensity),
    );
    expect(levels.size).toBeGreaterThanOrEqual(3);
  });

  it("rests with no highlight during the idle gap", () => {
    const text = "abc";
    const cycle = shimmerCycleLength(text);
    for (let tick = cycle - SHIMMER_GAP; tick < cycle; tick += 1) {
      expect(
        computeShimmerSpans(text, tick).every((span) => span.intensity === 0),
      ).toBe(true);
    }
  });

  it("advances 25 graphemes per second and retains a 600ms rest", () => {
    expect(SHIMMER_INTERVAL_MS).toBe(50);
    expect(SHIMMER_GAP * SHIMMER_INTERVAL_MS).toBe(600);
    const text = "x".repeat(60);
    const peaks = (elapsedMs: number): number[] => {
      const intensities = computeShimmerSpans(
        text,
        elapsedMs / SHIMMER_INTERVAL_MS,
      ).flatMap((span) => Array.from(span.text, () => span.intensity));
      const peak = Math.max(...intensities);
      return intensities.flatMap((intensity, index) =>
        intensity === peak ? [index] : [],
      );
    };
    expect(peaks(1600)).toEqual(peaks(600).map((index) => index + 25));
  });

  it("mixes hex colours and declines named colours", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("magenta", "#ffffff", 0.5)).toBeUndefined();
    expect(PULSE_FRAMES.length).toBeGreaterThan(1);
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

  it("uses one 50ms clock with a slower 200ms glyph and a 2s pulse cycle", () => {
    vi.useFakeTimers();
    process.env.OHBABY_TUI_NO_ANIM = "0";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let app: ReturnType<typeof render> | undefined;

    act(() => {
      app = render(<ShimmerText text="Igniting the cosmo" />);
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 50);
    expect(app?.lastFrame()).toContain(PULSE_FRAMES[0]);
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(app?.lastFrame()).toContain(PULSE_FRAMES[0]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(app?.lastFrame()).toContain(PULSE_FRAMES[1]);
    for (let frame = 2; frame < 10; frame++) {
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(app?.lastFrame()).toContain(PULSE_FRAMES[frame]);
    }
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(app?.lastFrame()).toContain(PULSE_FRAMES[0]);
    // Text content is stable across ticks; only the highlight colour moves.
    expect(app?.lastFrame()).toContain("Igniting the cosmo");
    act(() => {
      app?.rerender(<ShimmerText text="A different, longer waiting phrase" />);
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    act(() => {
      app?.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("keeps emoji graphemes intact at every colored segment boundary", () => {
  const graphemes = ["a", "👨‍👩‍👧‍👦", "👩🏽‍💻", "❤️", "🇹🇼", "é", "b"];
  const text = graphemes.join("");
  const boundaries = new Set([0]);
  let length = 0;
  for (const grapheme of graphemes) {
    length += grapheme.length;
    boundaries.add(length);
  }
  for (let tick = 0; tick < shimmerCycleLength(text); tick++) {
    let offset = 0;
    for (const span of computeShimmerSpans(text, tick)) {
      expect(boundaries.has(offset)).toBe(true);
      offset += span.text.length;
    }
    expect(offset).toBe(text.length);
  }
});
