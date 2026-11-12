import type { UiModelActivity, UiRun } from "ohbaby-sdk";
import { useExecutionDuration } from "./execution-duration.js";
import { Box, Text } from "ink";
import { useRef } from "react";
import type { ReactElement } from "react";
import type { TuiRuntimeStatus } from "../store/snapshot.js";
import { useTheme } from "../theme/index.js";
import { ShimmerText } from "./shimmer-text.js";
import { pickWorkingPhrase } from "./working-phrases.js";

export interface WorkingSpinnerProps {
  readonly runtime: TuiRuntimeStatus;
  /** The active session's run behind `runtime`; command runs have none. */
  readonly run?: UiRun;
}

/**
 * One status slot for the whole agent run, as in pi: it holds the turn's
 * phrase and elapsed time while the run works, text streaming included, and
 * turns into `Retrying #n` while the service retries a failed model request.
 * It never comes and goes with single requests, so retries cannot blink it.
 */
export function WorkingSpinner({
  runtime,
  run,
}: WorkingSpinnerProps): ReactElement | null {
  // Call the hook unconditionally; an empty runId while idle keeps order stable.
  const runId = runtime.kind === "running" ? runtime.runId : "";
  const phrase = useTurnPhrase(runId);

  if (
    runtime.kind !== "running" ||
    run?.id !== runtime.runId ||
    run.status.kind !== "running" ||
    // A summary request belongs to compaction, which has its own status.
    run.modelActivity?.purpose === "context-summary"
  ) {
    return null;
  }
  const retry = retryNumber(run.modelActivity);
  // Real state titles take precedence temporarily; they do not replace the run phrase.
  const text = runtime.title?.trim() ? runtime.title : phrase;
  return retry === undefined ? (
    <VisibleWorkingPhrase text={text} run={run} />
  ) : (
    <RetryStatus retry={retry} />
  );
}

/**
 * Which retry this is: a failed attempt with a retry scheduled points at the
 * next one; a request running inside a retried chain is that retry.
 */
function retryNumber(
  activity: UiModelActivity | undefined,
): number | undefined {
  if (activity?.phase !== "retrying") return undefined;
  const retry =
    activity.outcome === "running" ? activity.attempt - 1 : activity.attempt;
  return retry >= 1 ? retry : undefined;
}

/** pi's retry indicator: the same slot in the warning colour, no timer. */
function RetryStatus({ retry }: { readonly retry: number }): ReactElement {
  const theme = useTheme();
  return <Text color={theme.status.warning}>Retrying #{retry}</Text>;
}

// Mount time-dependent hooks only while the indicator is visible.
function VisibleWorkingPhrase({
  text,
  run,
}: {
  readonly text: string;
  readonly run: UiRun;
}): ReactElement {
  // The turn's elapsed time, kept across requests and retries.
  const duration = useExecutionDuration(run.id, Date.parse(run.startedAt));
  return (
    <Box>
      <Box flexShrink={1}>
        <ShimmerText text={text} />
      </Box>
      {duration === undefined ? null : (
        <Box flexShrink={0}>
          <Text dimColor> {duration}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Returns one phrase fixed per turn. Re-picks only when runId changes, so the
 * phrase is stable across re-renders within a turn and rotates between turns.
 */
function useTurnPhrase(runId: string): string {
  const cache = useRef<{ runId: string; phrase: string } | null>(null);
  if (runId !== "" && cache.current?.runId !== runId) {
    cache.current = { runId, phrase: pickWorkingPhrase(runId) };
  }
  return cache.current?.phrase ?? "";
}
