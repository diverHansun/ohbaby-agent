import { Text } from "ink";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";

const SHIMMER_INTERVAL_MS = 55;
/** Idle steps between sweeps, so the highlight pauses off the end before looping. */
export const SHIMMER_GAP = 8;
/** Highlight window is the head character ± this many neighbours (5-char band). */
export const SHIMMER_HALF_WIDTH = 2;

export interface ShimmerSegments {
  readonly before: string;
  readonly shimmer: string;
  readonly after: string;
}

/** Total tick cycle for a phrase: one step per character plus the idle gap. */
export function shimmerCycleLength(text: string): number {
  return Array.from(text).length + SHIMMER_GAP;
}

/**
 * Split text into before / highlighted / after for the given tick. When the
 * highlight window sits entirely off the text (during the idle gap), `shimmer`
 * is empty and the whole phrase is `before`.
 */
export function computeShimmerSegments(
  text: string,
  tick: number,
): ShimmerSegments {
  const chars = Array.from(text);
  const start = tick - SHIMMER_HALF_WIDTH;
  const end = tick + SHIMMER_HALF_WIDTH;

  if (end < 0 || start >= chars.length) {
    return { before: text, shimmer: "", after: "" };
  }

  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(chars.length - 1, end);
  return {
    before: chars.slice(0, clampedStart).join(""),
    shimmer: chars.slice(clampedStart, clampedEnd + 1).join(""),
    after: chars.slice(clampedEnd + 1).join(""),
  };
}

export interface ShimmerTextProps {
  readonly text: string;
}

/**
 * Renders text with a single highlight that sweeps left-to-right, looping with a
 * short pause. The sweep conveys "alive" without rotating the words themselves.
 * Honors OHBABY_TUI_NO_ANIM by rendering the phrase flat.
 */
export function ShimmerText({ text }: ShimmerTextProps): ReactElement {
  const theme = useTheme();
  const animate = process.env.OHBABY_TUI_NO_ANIM !== "1";
  const cycleLength = shimmerCycleLength(text);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animate) {
      return undefined;
    }

    const interval = setInterval(() => {
      setTick((current): number => (current + 1) % cycleLength);
    }, SHIMMER_INTERVAL_MS);

    return (): void => {
      clearInterval(interval);
    };
  }, [animate, cycleLength]);

  const base = theme.workingSpinner.base;
  const highlight = theme.workingSpinner.highlight;

  if (!animate) {
    return <Text color={base}>{text}</Text>;
  }

  const { before, shimmer, after } = computeShimmerSegments(text, tick);
  if (shimmer === "") {
    return <Text color={base}>{text}</Text>;
  }

  return (
    <Text>
      {before ? <Text color={base}>{before}</Text> : null}
      <Text color={highlight}>{shimmer}</Text>
      {after ? <Text color={base}>{after}</Text> : null}
    </Text>
  );
}
