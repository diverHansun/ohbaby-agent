import { useExecutionDuration } from "../execution-duration.js";
import type { UiPromptSubmission } from "ohbaby-sdk";
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export function PromptCompletion({
  prompt,
}: {
  readonly prompt: UiPromptSubmission;
}): ReactElement {
  const duration = useExecutionDuration(
    prompt.promptId,
    prompt.endTimeSource === "recovery"
      ? undefined
      : Date.parse(prompt.acceptedAt ?? prompt.createdAt),
    prompt.endedAt === undefined ? undefined : Date.parse(prompt.endedAt),
  );
  return (
    <Box marginBottom={1}>
      <Text dimColor>
        {prompt.status === "succeeded" ? "" : `${prompt.status} · `}
        {prompt.endTimeSource === "recovery"
          ? "End time unknown (recovered)"
          : `Total ${duration ?? "—"}`}
      </Text>
    </Box>
  );
}
