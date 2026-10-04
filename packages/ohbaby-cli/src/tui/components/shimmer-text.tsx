import { Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";

/**
 * One 20 fps clock drives the sweep while the pulse glyph changes only every
 * 200ms. Both animations stay within the output budget of one changed row.
 */
export const SHIMMER_INTERVAL_MS = 50;
const PULSE_INTERVAL_MS = 200;
const SHIMMER_GRAPHEMES_PER_SECOND = 25;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Keep a 600ms rest off the end regardless of the animation refresh rate. */
export const SHIMMER_GAP = 600 / SHIMMER_INTERVAL_MS;
/** Graphemes on each side of the sweep head that still receive some light. */
export const SHIMMER_HALF_WIDTH = 6;
/** Graphemes the sweep head advances per tick. */
export const SHIMMER_STEP =
  (SHIMMER_GRAPHEMES_PER_SECOND * SHIMMER_INTERVAL_MS) / 1000;
/** Intensity levels; adjacent graphemes at one level share a styled span. */
const LEVELS = 5;
/** Pulse like Claude Code's working indicator rather than a tool spinner. */
export const PULSE_FRAMES = [
  "·",
  "✢",
  "✳",
  "✶",
  "✻",
  "✽",
  "✻",
  "✶",
  "✳",
  "✢",
] as const;

export interface ShimmerSpan {
  readonly text: string;
  /** 0 = base colour … 1 = full highlight. */
  readonly intensity: number;
}

function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), ({ segment }) => segment);
}

/** Ticks for one sweep across the phrase plus the idle gap. */
export function shimmerCycleLength(text: string): number {
  const span = graphemes(text).length + SHIMMER_HALF_WIDTH * 2;
  return Math.ceil(span / SHIMMER_STEP) + SHIMMER_GAP;
}

/**
 * Split the text into spans with a quantised highlight intensity for a tick.
 * The sweep head enters from the left, leaves on the right and rests during
 * the gap (every span at intensity 0). Grapheme clusters are never split.
 */
export function computeShimmerSpans(
  text: string,
  tick: number,
): readonly ShimmerSpan[] {
  const chars = graphemes(text);
  const head = tick * SHIMMER_STEP - SHIMMER_HALF_WIDTH;
  const spans: { text: string; intensity: number }[] = [];
  for (const [index, char] of chars.entries()) {
    const distance = Math.abs(index - head);
    const raw =
      distance >= SHIMMER_HALF_WIDTH
        ? 0
        : (1 + Math.cos((Math.PI * distance) / SHIMMER_HALF_WIDTH)) / 2;
    const intensity = Math.round(raw * (LEVELS - 1)) / (LEVELS - 1);
    const last = spans.at(-1);
    if (last?.intensity === intensity) last.text += char;
    else spans.push({ text: char, intensity });
  }
  return spans;
}

/** Linear sRGB mix of two `#rrggbb` colours; undefined for named colours. */
export function mixHex(
  base: string,
  highlight: string,
  amount: number,
): string | undefined {
  const parse = (hex: string): [number, number, number] | undefined => {
    const match = /^#([0-9a-f]{6})$/iu.exec(hex);
    if (!match) return undefined;
    const value = parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const from = parse(base);
  const to = parse(highlight);
  if (!from || !to) return undefined;
  const channel = (index: 0 | 1 | 2): string =>
    Math.round(from[index] + (to[index] - from[index]) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export interface ShimmerTextProps {
  readonly text: string;
}

/**
 * A pulsing glyph followed by the phrase with a soft highlight sweeping left to
 * right, looping after a short rest. The words themselves never move.
 * Honors OHBABY_TUI_NO_ANIM by rendering a static glyph and flat text.
 */
export function ShimmerText({ text }: ShimmerTextProps): ReactElement {
  const theme = useTheme();
  const animate = process.env.OHBABY_TUI_NO_ANIM !== "1";
  const cycleLength = useMemo(() => shimmerCycleLength(text), [text]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animate) {
      return undefined;
    }
    const interval = setInterval(() => {
      setTick((current): number => current + 1);
    }, SHIMMER_INTERVAL_MS);
    return (): void => {
      clearInterval(interval);
    };
  }, [animate]);

  const base = theme.workingSpinner.base;
  const highlight = theme.workingSpinner.highlight;
  const colors = useMemo(
    () =>
      Array.from(
        { length: LEVELS },
        (_, level) =>
          mixHex(base, highlight, level / (LEVELS - 1)) ??
          (level >= (LEVELS - 1) / 2 ? highlight : base),
      ),
    [base, highlight],
  );
  const pulseFrame = Math.floor(
    (tick * SHIMMER_INTERVAL_MS) / PULSE_INTERVAL_MS,
  );
  const glyph = animate ? PULSE_FRAMES[pulseFrame % PULSE_FRAMES.length] : "✻";
  const prefix = <Text color={theme.status.running}>{glyph} </Text>;

  if (!animate) {
    return (
      <Text wrap="truncate-end">
        {prefix}
        <Text color={base}>{text}</Text>
      </Text>
    );
  }

  return (
    <Text wrap="truncate-end">
      {prefix}
      {computeShimmerSpans(text, tick % cycleLength).map((span, index) => (
        <Text
          key={String(index)}
          color={colors[Math.round(span.intensity * (LEVELS - 1))]}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}
