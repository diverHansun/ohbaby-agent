import { Box, Text } from "ink";
import type {
  UiMessage,
  UiMessagePart,
  UiToolCall,
  UiToolResult,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { mdToAnsi } from "../../render/markdown.js";
import { wrapAnsi } from "../../render/wrap.js";
import { useTheme, type Theme } from "../../theme/index.js";
import { Spinner } from "../spinner.js";
import { renderToolLabel, renderToolPart } from "./parts/tool-part.js";

export interface MessageRowProps {
  readonly contentWidth: number;
  readonly message: UiMessage;
}

export type PairedMessagePart =
  | {
      readonly index: number;
      readonly kind: "part";
      readonly part: UiMessagePart;
    }
  | {
      readonly call: UiToolCall;
      readonly index: number;
      readonly kind: "tool";
      readonly result?: UiToolResult;
    };

export function MessageRow({
  contentWidth,
  message,
}: MessageRowProps): ReactElement {
  const theme = useTheme();
  const partWidth = Math.max(
    1,
    contentWidth - (message.role === "user" ? 2 : 0),
  );
  const renderedParts = renderMessageParts(message, partWidth, theme);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderedParts.map((part) => (
        <Box key={`${message.id}_${String(part.index)}`}>
          {part.kind === "spinner" ? (
            <Spinner label={part.label} />
          ) : (
            renderTextPart(message, part)
          )}
        </Box>
      ))}
    </Box>
  );
}

export function pairToolCallResult(
  parts: readonly UiMessagePart[],
): readonly PairedMessagePart[] {
  const paired: PairedMessagePart[] = [];
  const callIds = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool-call") {
      callIds.add(part.call.id);
    }
  }

  const resultByCallId = new Map<string, UiToolResult>();
  for (const part of parts) {
    if (
      part.type === "tool-result" &&
      !resultByCallId.has(part.result.callId)
    ) {
      resultByCallId.set(part.result.callId, part.result);
    }
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part.type === "tool-call") {
      paired.push({
        call: part.call,
        index,
        kind: "tool",
        result: resultByCallId.get(part.call.id),
      });
      continue;
    }

    if (part.type === "tool-result" && callIds.has(part.result.callId)) {
      continue;
    }

    paired.push({ index, kind: "part", part });
  }

  return paired;
}

interface RenderedMessagePart {
  readonly color: string | undefined;
  readonly dimColor: boolean;
  readonly gutterColor?: string;
  readonly index: number;
  readonly kind: "text";
  readonly text: string;
}

interface RenderedSpinnerPart {
  readonly index: number;
  readonly kind: "spinner";
  readonly label: string;
}

export function renderMessageParts(
  message: UiMessage,
  partWidth: number,
  theme: Theme,
): readonly (RenderedMessagePart | RenderedSpinnerPart)[] {
  const rendered: (RenderedMessagePart | RenderedSpinnerPart)[] = [];

  for (const part of pairToolCallResult(message.parts)) {
    if (
      part.kind === "tool" &&
      (part.call.status === "running" || part.call.status === "pending")
    ) {
      rendered.push({
        index: part.index,
        kind: "spinner",
        label: renderToolLabel(part.call, part.result),
      });
      continue;
    }

    const text = renderPairedMessagePart(message, part, partWidth);
    if (text === "") {
      continue;
    }

    rendered.push({
      color:
        message.role === "user"
          ? theme.role.user
          : pairedPartColor(part, theme),
      dimColor: part.kind === "part" && part.part.type === "reasoning",
      gutterColor:
        message.role === "user" ? theme.message.userGutter : undefined,
      index: part.index,
      kind: "text",
      text,
    });
  }

  return rendered;
}

function renderTextPart(
  message: UiMessage,
  part: RenderedMessagePart,
): ReactElement {
  if (message.role !== "user") {
    return (
      <Text color={part.color} dimColor={part.dimColor}>
        {part.text}
      </Text>
    );
  }

  return (
    <Text>
      <Text color={part.gutterColor}>{part.index === 0 ? "| " : "  "}</Text>
      <Text color={part.color} dimColor={part.dimColor}>
        {part.text}
      </Text>
    </Text>
  );
}

function renderPairedMessagePart(
  message: UiMessage,
  part: PairedMessagePart,
  partWidth: number,
): string {
  if (part.kind === "tool") {
    return wrapAnsi(
      `  ${renderToolLabel(part.call, part.result)}`,
      partWidth,
    ).join("\n");
  }

  return renderSingleMessagePart(message, part.part, partWidth);
}

function renderSingleMessagePart(
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

function pairedPartColor(
  part: PairedMessagePart,
  theme: Theme,
): string | undefined {
  if (part.kind === "tool") {
    return part.call.status === "failed" || part.result?.error
      ? theme.tool.failed
      : theme.tool.name;
  }

  switch (part.part.type) {
    case "tool-call":
      return part.part.call.status === "failed"
        ? theme.tool.failed
        : theme.tool.name;
    case "tool-result":
      return part.part.result.error ? theme.tool.failed : theme.tool.success;
    case "reasoning":
      return theme.reasoning;
    case "text":
      return undefined;
  }
}
