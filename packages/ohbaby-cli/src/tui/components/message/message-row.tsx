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
import type { TuiReasoningViewState } from "../../store/snapshot.js";
import { useTheme, type Theme } from "../../theme/index.js";
import { Spinner } from "../spinner.js";
import {
  renderToolLabel,
  renderToolLabelParts,
  renderToolPart,
} from "./parts/tool-part.js";

const OUTPUT_TRUNCATED_LABEL = "output truncated";

export interface MessageRowProps {
  /** Bottom margin rows; 0 for transcript fragments that continue below. */
  readonly bottomMargin?: number;
  readonly contentWidth: number;
  readonly message: UiMessage;
  readonly reasoning?: TuiReasoningViewState;
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
  bottomMargin = 1,
  contentWidth,
  message,
  reasoning,
}: MessageRowProps): ReactElement {
  const theme = useTheme();
  const partWidth = Math.max(
    1,
    contentWidth - (message.role === "user" ? 2 : 0),
  );
  const renderedParts = renderMessageParts(
    message,
    partWidth,
    theme,
    reasoning,
  );

  return (
    <Box flexDirection="column" marginBottom={bottomMargin}>
      <MessageParts message={message} parts={renderedParts} />
    </Box>
  );
}

export function MessageParts({
  message,
  parts,
}: {
  readonly message: UiMessage;
  readonly parts: readonly RenderedPart[];
}): ReactElement {
  return (
    <>
      {parts.map((part) => (
        <Box key={`${message.id}_${String(part.index)}`}>
          {part.kind === "spinner"
            ? renderSpinnerPart(part)
            : renderTextPart(message, part)}
        </Box>
      ))}
    </>
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

export interface RenderedMessagePart {
  readonly backgroundColor?: string;
  readonly color: string | undefined;
  readonly dimColor: boolean;
  readonly gutterColor?: string;
  readonly indent: number;
  readonly index: number;
  readonly kind: "text";
  readonly segments?: readonly RenderedTextSegment[];
  readonly text: string;
}

export interface RenderedTextSegment {
  readonly color: string | undefined;
  readonly dimColor?: boolean;
  readonly text: string;
}

export interface RenderedSpinnerPart {
  readonly index: number;
  readonly kind: "spinner";
  readonly label: string;
  readonly segments?: readonly RenderedTextSegment[];
}

export type RenderedPart = RenderedMessagePart | RenderedSpinnerPart;

export function renderMessageParts(
  message: UiMessage,
  partWidth: number,
  theme: Theme,
  reasoning?: TuiReasoningViewState,
): readonly (RenderedMessagePart | RenderedSpinnerPart)[] {
  const rendered: (RenderedMessagePart | RenderedSpinnerPart)[] = [];

  if (reasoning && message.role === "assistant") {
    rendered.push({
      color: theme.reasoning,
      dimColor: true,
      indent: 0,
      index: -1,
      kind: "text",
      text: reasoning.folded
        ? "Thought"
        : wrapAnsi(reasoning.content, partWidth).join("\n"),
    });
  }

  for (const part of pairToolCallResult(message.parts)) {
    if (
      part.kind === "tool" &&
      (part.call.status === "running" || part.call.status === "pending")
    ) {
      rendered.push({
        index: part.index,
        kind: "spinner",
        label: renderToolLabel(part.call, part.result),
        segments: renderToolLabelSegments(
          part.call,
          part.result,
          theme,
          renderToolLabel(part.call, part.result),
        ),
      });
      continue;
    }

    const indent = message.role === "user" ? 0 : pairedPartIndent(part);
    const renderedPart = renderPairedMessagePart(
      message,
      part,
      Math.max(1, partWidth - indent),
      theme,
    );
    if (renderedPart.text === "") {
      continue;
    }

    rendered.push({
      backgroundColor:
        message.role === "user" ? theme.message.userBlockBg : undefined,
      color:
        message.role === "user"
          ? theme.role.user
          : pairedPartColor(part, theme),
      dimColor: part.kind === "part" && part.part.type === "reasoning",
      gutterColor:
        message.role === "user" ? theme.message.userGutter : undefined,
      indent,
      index: part.index,
      kind: "text",
      ...(renderedPart.segments === undefined
        ? {}
        : { segments: renderedPart.segments }),
      text: renderedPart.text,
    });
  }

  if (shouldRenderOutputTruncated(message)) {
    rendered.push({
      color: undefined,
      dimColor: true,
      indent: 0,
      index: message.parts.length,
      kind: "text",
      text: OUTPUT_TRUNCATED_LABEL,
    });
  }

  return rendered;
}

function shouldRenderOutputTruncated(message: UiMessage): boolean {
  return (
    message.role === "assistant" &&
    message.status === "completed" &&
    message.finishReason === "length"
  );
}

function renderSpinnerPart(part: RenderedSpinnerPart): ReactElement {
  if (!part.segments) {
    return <Spinner label={part.label} />;
  }

  return (
    <Text>
      <Spinner />
      <Text> </Text>
      {part.segments.map((segment, index) => (
        <Text
          color={segment.color}
          dimColor={segment.dimColor}
          key={String(index)}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function renderTextPart(
  message: UiMessage,
  part: RenderedMessagePart,
): ReactElement {
  if (message.role !== "user") {
    return (
      <Box marginLeft={part.indent}>
        <Text color={part.color} dimColor={part.dimColor}>
          {part.segments
            ? part.segments.map((segment, index) => (
                <Text
                  color={segment.color}
                  dimColor={segment.dimColor}
                  key={String(index)}
                >
                  {segment.text}
                </Text>
              ))
            : part.text}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {part.text.split("\n").map((line, index) => (
        <Text backgroundColor={part.backgroundColor} key={String(index)}>
          <Text color={part.gutterColor}>
            {part.index === 0 && index === 0 ? "| " : "  "}
          </Text>
          <Text color={part.color} dimColor={part.dimColor}>
            {line}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function renderPairedMessagePart(
  message: UiMessage,
  part: PairedMessagePart,
  partWidth: number,
  theme: Theme,
): {
  readonly segments?: readonly RenderedTextSegment[];
  readonly text: string;
} {
  if (part.kind === "tool") {
    const text = wrapAnsi(
      renderToolLabel(part.call, part.result),
      partWidth,
    ).join("\n");
    return {
      segments: renderToolLabelSegments(part.call, part.result, theme, text),
      text,
    };
  }

  return { text: renderSingleMessagePart(message, part.part, partWidth) };
}

function renderToolLabelSegments(
  call: UiToolCall,
  result: UiToolResult | undefined,
  theme: Theme,
  wrappedText: string,
): readonly RenderedTextSegment[] {
  const parts = renderToolLabelParts(call, result);
  const nameText = parts.name;
  const summaryText = parts.summary === "" ? "" : ` ${parts.summary}`;
  const errorText = parts.error === "" ? "" : ` ${parts.error}`;
  const nameEnd = Array.from(nameText).length;
  const errorStart = Array.from(`${nameText}${summaryText}`).length;
  const rawChars = Array.from(`${nameText}${summaryText}${errorText}`);
  const segments: RenderedTextSegment[] = [];
  let rawIndex = 0;

  for (const char of Array.from(wrappedText)) {
    appendSegment(
      segments,
      colorForToolLabelIndex(rawIndex, theme, {
        errorStart,
        hasError: errorText !== "",
        nameEnd,
      }),
      char,
    );

    if (rawChars[rawIndex] === char || char !== "\n") {
      rawIndex += 1;
    }
  }

  return segments;
}

function appendSegment(
  segments: RenderedTextSegment[],
  color: string,
  text: string,
): void {
  const previous = segments.at(-1);
  if (previous?.color === color && previous.dimColor === undefined) {
    segments[segments.length - 1] = {
      color,
      text: `${previous.text}${text}`,
    };
    return;
  }
  segments.push({ color, text });
}

function colorForToolLabelIndex(
  rawIndex: number,
  theme: Theme,
  boundaries: {
    readonly errorStart: number;
    readonly hasError: boolean;
    readonly nameEnd: number;
  },
): string {
  if (rawIndex < boundaries.nameEnd) {
    return theme.tool.name;
  }
  if (boundaries.hasError && rawIndex >= boundaries.errorStart) {
    return theme.tool.failed;
  }
  return theme.tool.arg;
}

function pairedPartIndent(part: PairedMessagePart): number {
  if (part.kind === "tool") {
    return 2;
  }

  return part.part.type === "tool-call" || part.part.type === "tool-result"
    ? 2
    : 0;
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
