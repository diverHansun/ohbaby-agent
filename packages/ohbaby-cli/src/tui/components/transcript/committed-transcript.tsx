import { Box, useStdout } from "ink";
import { memo, type ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import type { TranscriptItem } from "../../store/transcript.js";
import { ReplayableTranscript } from "./replayable-transcript.js";
import { PromptCompletion } from "./prompt-completion.js";
import { MessageRow } from "../message/message-row.js";

export interface CommittedTranscriptProps {
  readonly items: readonly TranscriptItem[];
}

interface StaticTranscriptDecisionInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly platform?: NodeJS.Platform;
}

export const CommittedTranscript = memo(function CommittedTranscript({
  items,
}: CommittedTranscriptProps): ReactElement {
  const layout = useTuiLayout();
  const { stdout } = useStdout();
  const useStatic = shouldUseStaticTranscript({
    isTTY: "isTTY" in stdout && stdout.isTTY === true,
  });

  if (useStatic) {
    return <ReplayableTranscript items={items} />;
  }

  return (
    <Box flexDirection="column">
      {items.map((item) =>
        item.promptCompletion ? (
          <PromptCompletion key={item.id} prompt={item.promptCompletion} />
        ) : (
          <MessageRow
            bottomMargin={item.spacing ? 1 : 0}
            contentWidth={layout.contentWidth}
            key={item.id}
            message={item.message}
          />
        ),
      )}
    </Box>
  );
});

export function shouldUseStaticTranscript(
  input: StaticTranscriptDecisionInput = {},
): boolean {
  const env = input.env ?? process.env;
  const override = env.OHBABY_TUI_STATIC_TRANSCRIPT?.trim();

  if (override === "0" || override?.toLowerCase() === "false") {
    return false;
  }

  if (override === "1" || override?.toLowerCase() === "true") {
    return true;
  }

  return input.isTTY === true;
}
