import { useExecutionDuration } from "../execution-duration.js";
import { turnTriggerLabel, type UiPromptError, type UiTurn } from "ohbaby-sdk";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useTheme } from "../../theme/index.js";

/**
 * A turn's end line: what started it when not the user, its result and total
 * time. A failed turn adds pi's red `Error:` line with the service's safe
 * reason and, when there was one, the HTTP status; it stays in the history.
 */
export function PromptCompletion({
  turn,
}: {
  readonly turn: UiTurn;
}): ReactElement {
  const theme = useTheme();
  const { timing } = turn;
  const duration = useExecutionDuration(
    timing.id,
    timing.startedAt === undefined ? undefined : Date.parse(timing.startedAt),
    Date.parse(timing.endedAt),
  );
  const label = turnTriggerLabel(turn.trigger);
  const result = timing.recovered
    ? `${timing.status ?? "ended"} · End time unknown (recovered)`
    : `${
        timing.status === undefined || timing.status === "succeeded"
          ? ""
          : `${timing.status} · `
      }Total ${duration ?? "—"}`;
  const error =
    turn.error && !isExpectedInterruption(timing.status, turn.error)
      ? turn.error
      : undefined;
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text dimColor>{label ? `${label} · ${result}` : result}</Text>
      {error ? (
        <Text>
          <Text color={theme.status.error}>Error: {error.message}</Text>
          {error.statusCode === undefined ? null : (
            <Text dimColor> HTTP {error.statusCode}</Text>
          )}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * A stop the user or the service meant (stop, shutdown) ends the turn
 * normally; it is not a failure to report. Same rule as the web client.
 */
export function isExpectedInterruption(
  status: string | undefined,
  error: UiPromptError,
): boolean {
  if (status !== "interrupted" || error.source !== "runtime") return false;
  const reason =
    (error.terminalReason === undefined ||
      error.terminalReason === "cancelled") &&
    error.code === "RUN_INTERRUPTED"
      ? error.message
      : error.terminalReason;
  return reason === "user-stop" || reason === "service-shutdown";
}
