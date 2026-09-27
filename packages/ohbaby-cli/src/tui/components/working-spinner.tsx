import type { UiModelRequest } from "ohbaby-sdk";
import { useExecutionDuration } from "./execution-duration.js";
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
  readonly modelActivity?: UiModelRequest;
}

/**
 * Model waiting indicator for an owned agent-step attempt before its first text.
 */
export function WorkingSpinner({
  runtime,
  modelActivity,
}: WorkingSpinnerProps): ReactElement | null {
  const theme = useTheme();
  // Call the hook unconditionally; an empty runId while idle keeps order stable.
  const runId = runtime.kind === "running" ? runtime.runId : "";
  const phrase = useTurnPhrase(runId);

  const duration = useExecutionDuration(
    modelActivity?.requestId ?? "model",
    modelActivity?.startedAt,
    modelActivity?.endedAt,
  );
  if (
    runtime.kind !== "running" ||
    modelActivity?.runId !== runtime.runId ||
    modelActivity.purpose !== "agent-step" ||
    modelActivity.outcome !== "running" ||
    modelActivity.endedAt !== undefined ||
    modelActivity.firstTextAt !== undefined
  ) {
    return null;
  }
  const text = runtime.title?.trim() ? runtime.title : phrase;

  return (
    <Box>
      <Spinner color={theme.workingSpinner.base} />
      <Text> </Text>
      <ShimmerText text={text} />
      {duration === undefined ? null : <Text dimColor> · {duration}</Text>}
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
