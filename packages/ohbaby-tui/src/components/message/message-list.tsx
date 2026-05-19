import { Box, Text } from "ink";
import type { UiMessage, UiMessagePart, UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { TuiCommandNotice } from "../../store/snapshot.js";
import { renderToolPart } from "./parts/tool-part.js";

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
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <Box flexDirection="column" key={message.id} marginBottom={1}>
          <Text bold={message.role === "user"} color={roleColor(message.role)}>
            {roleLabel(message.role)}
          </Text>
          {message.parts.map((part, index) => (
            <Box key={`${message.id}_${String(index)}`} marginLeft={2}>
              <Text
                color={partColor(part)}
                dimColor={part.type === "reasoning"}
              >
                {renderMessagePart(part)}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {notices.map((notice) => (
        <Box flexDirection="row" key={notice.id} marginBottom={1}>
          <Text color={noticeColor(notice.level)}>notice</Text>
          <Text dimColor> {notice.title}: </Text>
          <Text>{notice.message}</Text>
          {notice.source === undefined ? null : (
            <Text dimColor> ({notice.source})</Text>
          )}
        </Box>
      ))}
      {commandNotices.map((notice) => (
        <Box
          flexDirection="row"
          key={notice.id}
          marginBottom={1}
        >
          <Text color={notice.kind === "error" ? "red" : "green"}>
            command
          </Text>
          <Text dimColor> {notice.commandId}: </Text>
          <Text>{notice.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

function noticeColor(level: UiNotice["level"]): string | undefined {
  switch (level) {
    case "error":
      return "red";
    case "warning":
      return "yellow";
    case "info":
      return "cyan";
  }
}

function renderMessagePart(part: UiMessagePart): string {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    case "tool-call":
    case "tool-result":
      return renderToolPart(part);
  }
}

function roleLabel(role: UiMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    case "user":
      return "you";
  }
}

function roleColor(role: UiMessage["role"]): string | undefined {
  switch (role) {
    case "assistant":
      return "cyan";
    case "system":
      return "gray";
    case "tool":
      return "magenta";
    case "user":
      return "green";
  }
}

function partColor(part: UiMessagePart): string | undefined {
  switch (part.type) {
    case "tool-call":
      return "yellow";
    case "tool-result":
      return part.result.error ? "red" : "green";
    case "reasoning":
      return "gray";
    case "text":
      return undefined;
  }
}
