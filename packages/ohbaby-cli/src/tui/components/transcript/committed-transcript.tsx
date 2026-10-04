import { Box, useStdout } from "ink";
import { memo, useContext, type ReactElement } from "react";
import {
  TranscriptDocumentContext,
  useTuiLayout,
} from "../../layout/context.js";
import type { TranscriptItem } from "../../store/transcript.js";
import { ReplayableTranscript } from "./replayable-transcript.js";
import { PromptCompletion } from "./prompt-completion.js";
import { MessageRow } from "../message/message-row.js";

export interface CommittedTranscriptProps {
  readonly toolsExpanded?: boolean;
  readonly items: readonly TranscriptItem[];
}

interface StaticTranscriptDecisionInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly platform?: NodeJS.Platform;
}

export const CommittedTranscript = memo(function CommittedTranscript({
  items,
  toolsExpanded = false,
}: CommittedTranscriptProps): ReactElement {
  const layout = useTuiLayout();
  const { stdout } = useStdout();
  const fullDocument = useContext(TranscriptDocumentContext);
  const useStatic =
    !fullDocument &&
    shouldUseStaticTranscript({
      isTTY: "isTTY" in stdout && stdout.isTTY === true,
    });

  if (useStatic) {
    return <ReplayableTranscript items={items} toolsExpanded={toolsExpanded} />;
  }

  const partStarts = new Map<string, number>();
  const entries = items.map((item) => {
    const start = partStarts.get(item.messageId) ?? 0;
    if (!item.promptCompletion)
      partStarts.set(item.messageId, start + item.message.parts.length);
    return { item, anchorId: transcriptAnchorId(item.messageId, start) };
  });
  return (
    <Box flexDirection="column">
      {entries.map(({ item, anchorId }) =>
        item.promptCompletion ? (
          <PromptCompletion key={item.id} prompt={item.promptCompletion} />
        ) : (
          <MessageRow
            anchorId={anchorId}
            bottomMargin={item.spacing ? 1 : 0}
            contentWidth={layout.contentWidth}
            key={item.id}
            toolsExpanded={toolsExpanded}
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

/** Stable across live → committed fragment transitions. */
export function transcriptAnchorId(
  messageId: string,
  partStart: number,
): string {
  return JSON.stringify([messageId, partStart]);
}
