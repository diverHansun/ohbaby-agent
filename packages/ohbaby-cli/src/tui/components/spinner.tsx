import { Text } from "ink";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";

const SPINNER_INTERVAL_MS = 80;

export interface SpinnerProps {
  readonly label?: string;
}

export function Spinner({ label }: SpinnerProps): ReactElement {
  const theme = useTheme();
  const animate = process.env.OHBABY_TUI_NO_ANIM !== "1";
  const [frameIndex, setFrameIndex] = useState(0);
  const frames = theme.spinner.frames;
  const palette = theme.spinner.palette;
  const frame = frames[frameIndex % frames.length] ?? "⠋";
  const color = palette[frameIndex % palette.length];

  useEffect(() => {
    if (!animate) {
      return undefined;
    }

    const interval = setInterval(() => {
      setFrameIndex((current): number => (current + 1) % frames.length);
    }, SPINNER_INTERVAL_MS);

    return (): void => {
      clearInterval(interval);
    };
  }, [animate, frames.length]);

  return (
    <Text color={color}>
      {frame}
      {label ? ` ${label}` : ""}
    </Text>
  );
}
