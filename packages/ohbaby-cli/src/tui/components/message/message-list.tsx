import { Box } from "ink";
import type { UiMessage, UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import type { TuiCommandNotice } from "../../store/snapshot.js";
import { MessageRow } from "./message-row.js";
import { NoticeBanner } from "./notice-banner.js";

export interface MessageListProps {
  readonly messages: readonly UiMessage[];
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly notices: readonly UiNotice[];
}

export function MessageList({
  commandNotices,
  messages,
  notices,
}: MessageListProps): ReactElement {
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
      <NoticeBanner commandNotices={commandNotices} notices={notices} />
    </Box>
  );
}
