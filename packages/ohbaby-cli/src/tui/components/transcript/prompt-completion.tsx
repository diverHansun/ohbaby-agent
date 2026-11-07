import { useExecutionDuration } from "../execution-duration.js";
import { turnTriggerLabel, type UiTurn } from "ohbaby-sdk";
import { Box, Text } from "ink";
import type { ReactElement } from "react";

/** A turn's end line: what started it when not the user, its result and total time. */
export function PromptCompletion({
  turn,
}: {
  readonly turn: UiTurn;
}): ReactElement {
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
  return (
    <Box marginBottom={1}>
      <Text dimColor>{label ? `${label} · ${result}` : result}</Text>
    </Box>
  );
}
