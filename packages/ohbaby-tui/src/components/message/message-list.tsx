import { Box, Text } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { TuiCommandNotice } from "../../store/snapshot.js";
import { renderToolPart } from "./parts/tool-part.js";

export interface MessageListProps {
  readonly messages: readonly UiMessage[];
  readonly notices: readonly TuiCommandNotice[];
}

export function MessageList({
  messages,
  notices,
}: MessageListProps): ReactElement {
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <Text key={message.id}>
          {message.role}: {renderMessageText(message)}
        </Text>
      ))}
      {notices.map((notice) => (
        <Text
          color={notice.kind === "error" ? "red" : "green"}
          key={notice.id}
        >
          command {notice.commandId}: {notice.text}
        </Text>
      ))}
    </Box>
  );
}

function renderMessageText(message: UiMessage): string {
  return message.parts
    .map((part) => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return part.text;
        case "tool-call":
        case "tool-result":
          return renderToolPart(part);
      }
    })
    .join("");
}
