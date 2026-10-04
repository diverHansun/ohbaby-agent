import { Box, Text } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { memo, useContext, type ReactElement } from "react";
import {
  TranscriptDocumentContext,
  LiveTailRefContext,
  useTuiLayout,
} from "../../layout/context.js";
import type { TuiReasoningViewState } from "../../store/snapshot.js";
import {
  MessageRow,
  MessageParts,
  renderMessageParts,
} from "../message/message-row.js";
import { useTheme } from "../../theme/index.js";
import { clampRenderedPartsToTail } from "./live-tail-window.js";

export interface LiveTailProps {
  readonly anchorId?: string;
  readonly toolsExpanded?: boolean;
  readonly message: UiMessage | null;
  readonly reasoning?: TuiReasoningViewState;
}

export const LiveTail = memo(function LiveTail({
  anchorId,
  message,
  reasoning,
  toolsExpanded = false,
}: LiveTailProps): ReactElement | null {
  const layout = useTuiLayout();
  const liveTailRef = useContext(LiveTailRefContext);
  const theme = useTheme();
  const fullDocument = useContext(TranscriptDocumentContext);

  if (!message) {
    return null;
  }

  if (fullDocument)
    return (
      <MessageRow
        anchorId={anchorId}
        bottomMargin={0}
        message={message}
        contentWidth={layout.contentWidth}
        reasoning={reasoning}
        toolsExpanded={toolsExpanded}
      />
    );

  const partWidth = Math.max(
    1,
    layout.contentWidth - (message.role === "user" ? 2 : 0),
  );
  const rendered = renderMessageParts(
    message,
    partWidth,
    theme,
    reasoning,
    toolsExpanded,
  );
  const window = clampRenderedPartsToTail(
    rendered,
    Math.max(0, layout.liveTailRows - (liveTailRef ? 1 : 0)),
  );

  return (
    <Box
      ref={liveTailRef}
      flexDirection="column"
      marginBottom={liveTailRef ? 0 : 1}
      paddingBottom={liveTailRef && layout.liveTailRows > 0 ? 1 : 0}
      maxHeight={layout.liveTailRows}
      overflow="hidden"
    >
      {window.hiddenLineCount > 0 && layout.liveTailRows > 0 ? (
        <Text dimColor>
          ... (+{String(window.hiddenLineCount)} earlier lines)
        </Text>
      ) : null}
      <MessageParts message={message} parts={window.parts} />
    </Box>
  );
});
