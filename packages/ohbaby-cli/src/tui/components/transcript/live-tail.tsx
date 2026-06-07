import { Box } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { memo, type ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { MessageRow } from "../message/message-row.js";

export interface LiveTailProps {
  readonly message: UiMessage | null;
}

export const LiveTail = memo(function LiveTail({
  message,
}: LiveTailProps): ReactElement | null {
  const layout = useTuiLayout();

  if (!message) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <MessageRow contentWidth={layout.contentWidth} message={message} />
    </Box>
  );
});
