import { Box, Text } from "ink";
import type { UiMessage, UiMessagePart, UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { mdToAnsi } from "../../render/markdown.js";
import { wrapAnsi } from "../../render/wrap.js";
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
  const layout = useTuiLayout();

  return (
    <Box flexDirection="column">
      {messages.map((message) => {
        const renderedParts = message.parts
          .map((part, index) => ({
            index,
            part,
            text: renderMessagePart(
              message,
              part,
              Math.max(
                1,
                layout.contentWidth - (message.role === "user" ? 2 : 0),
              ),
            ),
          }))
          .filter((part) => part.text !== "");

        return (
          <Box flexDirection="column" key={message.id} marginBottom={1}>
            {renderedParts.map(({ index, part, text }) => (
              <Box key={`${message.id}_${String(index)}`}>
                <Text
                  color={message.role === "user" ? "green" : partColor(part)}
                  dimColor={part.type === "reasoning"}
                >
                  {message.role === "user"
                    ? `${index === 0 ? "| " : "  "}${text}`
                    : text}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}
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
        <Box flexDirection="row" key={notice.id} marginBottom={1}>
          <Text color={notice.kind === "error" ? "red" : "green"}>command</Text>
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

function renderMessagePart(
  message: UiMessage,
  part: UiMessagePart,
  partWidth: number,
): string {
  switch (part.type) {
    case "text":
      return message.role === "assistant"
        ? mdToAnsi(part.text, { width: partWidth }).join("\n")
        : wrapAnsi(part.text, partWidth).join("\n");
    case "reasoning":
      return message.status === "streaming"
        ? wrapAnsi(part.text, partWidth).join("\n")
        : "Thought";
    case "tool-call":
    case "tool-result":
      return wrapAnsi(renderToolPart(part), partWidth).join("\n");
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
