import { Box, Text } from "ink";
import type { UiMessage, UiMessagePart, UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { mdToAnsi } from "../../render/markdown.js";
import { wrapAnsi } from "../../render/wrap.js";
import type { TuiCommandNotice } from "../../store/snapshot.js";
import { tuiTheme } from "../../theme.js";
import { renderToolCallLine, renderToolPart } from "./parts/tool-part.js";

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
        const partWidth = Math.max(
          1,
          layout.contentWidth - (message.role === "user" ? 2 : 0),
        );
        const renderedParts = renderMessageParts(message, partWidth);

        return (
          <Box flexDirection="column" key={message.id} marginBottom={1}>
            {renderedParts.map(({ index, part, text }) => (
              <Box key={`${message.id}_${String(index)}`}>
                <Text
                  color={
                    message.role === "user" ? tuiTheme.colors.user : partColor(part)
                  }
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
          <Text
            color={
              notice.kind === "error"
                ? tuiTheme.colors.error
                : tuiTheme.colors.success
            }
          >
            command
          </Text>
          <Text dimColor> {notice.commandId}: </Text>
          <Text>{notice.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

interface RenderedMessagePart {
  readonly index: number;
  readonly part: UiMessagePart;
  readonly text: string;
}

function renderMessageParts(
  message: UiMessage,
  partWidth: number,
): readonly RenderedMessagePart[] {
  const rendered: RenderedMessagePart[] = [];
  for (let index = 0; index < message.parts.length; index += 1) {
    const part = message.parts[index];
    const nextPart = message.parts.at(index + 1);

    if (
      part.type === "tool-call" &&
      nextPart?.type === "tool-result" &&
      nextPart.result.callId === part.call.id
    ) {
      const text = wrapAnsi(
        renderToolCallLine(part.call, nextPart.result),
        partWidth,
      ).join("\n");
      if (text !== "") {
        rendered.push({ index, part, text });
      }
      index += 1;
      continue;
    }

    const text = renderMessagePart(message, part, partWidth);
    if (text !== "") {
      rendered.push({ index, part, text });
    }
  }

  return rendered;
}

function noticeColor(level: UiNotice["level"]): string | undefined {
  switch (level) {
    case "error":
      return tuiTheme.colors.error;
    case "warning":
      return tuiTheme.colors.warning;
    case "info":
      return tuiTheme.colors.accent;
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
      return part.call.status === "failed"
        ? tuiTheme.colors.error
        : tuiTheme.colors.tool;
    case "tool-result":
      return part.result.error ? tuiTheme.colors.error : tuiTheme.colors.success;
    case "reasoning":
      return tuiTheme.colors.reasoning;
    case "text":
      return undefined;
  }
}
