import { Box, Text } from "ink";
import { useRef } from "react";
import type { ReactElement } from "react";
import type { TuiRuntimeStatus } from "../store/snapshot.js";
import { useTheme } from "../theme/index.js";
import { ShimmerText } from "./shimmer-text.js";
import { Spinner } from "./spinner.js";
import { pickWorkingPhrase } from "./working-phrases.js";

export interface WorkingSpinnerProps {
  readonly runtime: TuiRuntimeStatus;
}

/**
 * Turn-level "agent is working" heartbeat for the main conversation. Visible only
 * while runtime.kind === "running": a rotating dot glyph (shared with tool rows,
 * tinted purple) plus a per-turn humorous phrase that shimmers left-to-right.
 */
export function WorkingSpinner({
  runtime,
}: WorkingSpinnerProps): ReactElement | null {
  const theme = useTheme();
  // Call the hook unconditionally; an empty runId while idle keeps order stable.
  const runId = runtime.kind === "running" ? runtime.runId : "";
  const phrase = useTurnPhrase(runId);

  if (runtime.kind !== "running") {
    return null;
  }

  return (
    <Box>
      <Spinner color={theme.workingSpinner.base} />
      <Text> </Text>
      <ShimmerText text={phrase} />
    </Box>
  );
}

/**
 * Returns one phrase fixed per turn. Re-picks only when runId changes, so the
 * phrase is stable across re-renders within a turn and rotates between turns.
 */
function useTurnPhrase(runId: string): string {
  const cache = useRef<{ runId: string; phrase: string } | null>(null);
  if (cache.current?.runId !== runId) {
    cache.current = { runId, phrase: pickWorkingPhrase() };
  }
  return cache.current.phrase;
}
