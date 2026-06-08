import { Text } from "ink";
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTheme } from "../theme/index.js";

const SPINNER_INTERVAL_MS = 80;

export interface SpinnerProps {
  readonly children?: ReactNode;
  readonly label?: string;
}

export function Spinner({ children, label }: SpinnerProps): ReactElement {
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
    <Text>
      <Text color={color}>{frame}</Text>
      {label ? <Text> {label}</Text> : null}
      {children}
    </Text>
  );
}
