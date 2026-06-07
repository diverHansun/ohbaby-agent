import { Box } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { memo, type ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { MessageRow } from "../message/message-row.js";

export interface CommittedTranscriptProps {
  readonly messages: readonly UiMessage[];
}

export const CommittedTranscript = memo(function CommittedTranscript({
  messages,
}: CommittedTranscriptProps): ReactElement {
  const layout = useTuiLayout();

  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageRow
          contentWidth={layout.contentWidth}
          key={message.id}
          message={message}
        />
      ))}
    </Box>
  );
});
