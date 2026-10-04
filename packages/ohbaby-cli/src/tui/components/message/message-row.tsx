import type { UiToolExecution } from "ohbaby-sdk";
import { useExecutionDuration } from "../execution-duration.js";
import { Box, Text, measureElement, type DOMElement } from "ink";
import {
  TranscriptAnchorContext,
  TranscriptWindowContext,
} from "../../layout/context.js";
import type {
  UiMessage,
  UiMessagePart,
  UiToolCall,
  UiToolResult,
} from "ohbaby-sdk";
import {
  memo,
  useCallback,
  useContext,
  useRef,
  useState,
  useLayoutEffect,
  type ReactElement,
} from "react";
import { mdToAnsi } from "../../render/markdown.js";
import { visibleWidth, wrapAnsi } from "../../render/wrap.js";
import type { TuiReasoningViewState } from "../../store/snapshot.js";
import { useTheme, type Theme } from "../../theme/index.js";
import { Spinner } from "../spinner.js";
import { renderToolLabelParts, renderToolPart } from "./parts/tool-part.js";

import { renderToolDisplay } from "./parts/tool-display.js";

const OUTPUT_TRUNCATED_LABEL = "output truncated";

export interface MessageRowProps {
  readonly anchorId?: string;
  /** Bottom margin rows; 0 for transcript fragments that continue below. */
  readonly bottomMargin?: number;
  readonly contentWidth: number;
  readonly message: UiMessage;
  readonly reasoning?: TuiReasoningViewState;
  readonly toolsExpanded?: boolean;
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

export const MessageRow = memo(function MessageRow({
  anchorId,
  bottomMargin = 1,
  contentWidth,
  message,
  reasoning,
  toolsExpanded = false,
}: MessageRowProps): ReactElement {
  const theme = useTheme();
  const anchors = useContext(TranscriptAnchorContext);
  const window = useContext(TranscriptWindowContext);
  const element = useRef<DOMElement | null>(null);
  const [measured, setMeasured] = useState<{
    message: UiMessage;
    width: number;
    theme: Theme;
    expanded: boolean;
    height: number;
  }>();
  const valid =
    measured?.message === message &&
    measured.width === contentWidth &&
    measured.theme === theme &&
    measured.expanded === toolsExpanded;
  const geometry = element.current
    ? measureElement(element.current)
    : undefined;
  // Keep a measured spacer and anchor for sealed offscreen messages. Their
  // complete content is still available; mounting it again needs no network IO.
  const hidden = Boolean(
    anchorId &&
    message.status !== "streaming" &&
    window &&
    geometry &&
    valid &&
    (geometry.y + geometry.height < window.top - window.height ||
      geometry.y > window.top + window.height * 2),
  );
  useLayoutEffect(() => {
    if (!anchorId || !window || !element.current || valid) return;
    setMeasured({
      message,
      width: contentWidth,
      theme,
      expanded: toolsExpanded,
      height: measureElement(element.current).height,
    });
  });
  const register = useCallback(
    (node: DOMElement | null): void => {
      element.current = node;
      const id = anchorId ?? message.id;
      if (node) anchors?.set(id, node);
      else anchors?.delete(id);
    },
    [anchors, anchorId, message.id],
  );
  if (hidden && measured)
    return (
      <Box
        ref={register}
        height={measured.height}
        marginBottom={bottomMargin}
        flexShrink={0}
      />
    );

  const partWidth = Math.max(
    1,
    contentWidth - (message.role === "user" ? 2 : 0),
  );
  const renderedParts = renderMessageParts(
    message,
    partWidth,
    theme,
    reasoning,
    toolsExpanded,
  );

  return (
    <Box ref={register} flexDirection="column" marginBottom={bottomMargin}>
      <MessageParts message={message} parts={renderedParts} />
    </Box>
  );
});

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
          {part.execution ? (
            <ToolDuration
              callId={part.callId ?? "tool"}
              execution={part.execution}
            />
          ) : null}
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
  readonly width?: number;
  readonly backgroundColor?: string;
  readonly color: string | undefined;
  readonly dimColor: boolean;
  readonly gutterColor?: string;
  readonly indent: number;
  readonly index: number;
  readonly execution?: UiToolExecution;
  readonly callId?: string;
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
  readonly execution?: UiToolExecution;
  readonly callId?: string;
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
  _reasoning?: TuiReasoningViewState,
  toolsExpanded = false,
): readonly (RenderedMessagePart | RenderedSpinnerPart)[] {
  const rendered: (RenderedMessagePart | RenderedSpinnerPart)[] = [];

  for (const part of pairToolCallResult(message.parts)) {
    if (
      part.kind === "tool" &&
      part.result === undefined &&
      part.call.execution?.phase === "executing" &&
      part.call.execution.endedAt === undefined
    ) {
      const label = renderToolDisplay(
        part.call,
        undefined,
        Math.max(1, partWidth - 2),
        toolsExpanded,
        theme,
      )
        .map((line) => line.text)
        .join("\n");
      rendered.push({
        index: part.index,
        kind: "spinner",
        execution: part.call.execution,
        callId: part.call.id,
        label,
        segments: renderToolLabelSegments(part.call, part.result, theme, label),
      });
      continue;
    }

    const indent = message.role === "user" ? 0 : pairedPartIndent(part);
    const renderedPart = renderPairedMessagePart(
      message,
      part,
      Math.max(1, partWidth - indent),
      theme,
      toolsExpanded,
    );
    if (renderedPart.text === "") {
      continue;
    }

    rendered.push({
      width: partWidth,
      backgroundColor:
        message.role === "user" ? theme.message.userBlockBg : undefined,
      color:
        message.role === "user"
          ? theme.role.user
          : pairedPartColor(part, theme),
      dimColor: false,
      gutterColor:
        message.role === "user" ? theme.message.userGutter : undefined,
      indent,
      index: part.index,
      kind: "text",
      execution:
        part.kind === "tool"
          ? (part.result?.execution ?? part.call.execution)
          : undefined,
      callId: part.kind === "tool" ? part.call.id : undefined,
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
          <Text color={part.gutterColor}>{"│ "}</Text>
          <Text color={part.color} dimColor={part.dimColor}>
            {line}
            {/* Pad only to extend a fill; bare trailing spaces would just
                pollute copied text. */}
            {part.backgroundColor === undefined
              ? ""
              : " ".repeat(
                  Math.max(
                    0,
                    (part.width ?? visibleWidth(line)) - visibleWidth(line),
                  ),
                )}
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
  toolsExpanded: boolean,
): {
  readonly segments?: readonly RenderedTextSegment[];
  readonly text: string;
} {
  if (part.kind === "tool") {
    const lines = renderToolDisplay(
      part.call,
      part.result,
      partWidth,
      toolsExpanded,
      theme,
    );
    const segments: RenderedTextSegment[] = [];
    const name = renderToolLabelParts(part.call, part.result).name;
    lines.forEach((line, index) => {
      if (index === 0 && line.text.startsWith(name)) {
        segments.push({
          color: toolNameColor(part.call.name, theme),
          text: name,
        });
        segments.push({
          color: line.color,
          text: line.text.slice(name.length),
        });
      } else
        segments.push({
          color: line.color,
          dimColor: line.dimColor,
          text: line.text,
        });
      if (index < lines.length - 1)
        segments.push({
          color: line.color,
          dimColor: line.dimColor,
          text: "\n",
        });
    });
    return { segments, text: lines.map((line) => line.text).join("\n") };
  }

  if (part.part.type === "tool-result") {
    const result = part.part.result;
    const body = result.output === "" ? [] : wrapAnsi(result.output, partWidth);
    const shown =
      toolsExpanded || body.length <= 5
        ? body
        : [
            ...body.slice(0, 5),
            ...wrapAnsi(
              `… ${String(body.length - 5)} lines omitted`,
              partWidth,
            ),
          ];
    return {
      text: [
        ...(result.error ? wrapAnsi(`failed: ${result.error}`, partWidth) : []),
        ...shown,
        ...(result.outputAvailable === false && !result.error
          ? wrapAnsi("Output unavailable", partWidth)
          : []),
      ].join("\n"),
    };
  }

  return {
    text: renderSingleMessagePart(message, part.part, partWidth, theme),
  };
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
        nameColor: toolNameColor(call.name, theme),
        statusColor:
          (result?.execution ?? call.execution)?.phase ===
            "awaiting-approval" &&
          !result?.error &&
          call.status !== "failed"
            ? theme.status.waiting
            : theme.tool.failed,
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
    readonly nameColor: string;
    readonly statusColor: string;
  },
): string {
  if (rawIndex < boundaries.nameEnd) {
    return boundaries.nameColor;
  }
  if (boundaries.hasError && rawIndex >= boundaries.errorStart) {
    return boundaries.statusColor;
  }
  return theme.tool.arg;
}

function toolNameColor(name: string, theme: Theme): string {
  if (["read", "glob", "grep", "web_search", "web_fetch"].includes(name))
    return theme.tool.read;
  if (["write", "edit"].includes(name)) return theme.tool.edit;
  return theme.tool.name;
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
  theme: Theme,
): string {
  switch (part.type) {
    case "text":
      return message.role === "assistant"
        ? mdToAnsi(part.text, { width: partWidth, theme }).join("\n")
        : wrapAnsi(part.text, partWidth).join("\n");
    case "reasoning":
      return part.saveState === "failed" ? "Reasoning could not be saved" : "";
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
      return part.part.saveState === "failed"
        ? theme.status.error
        : theme.reasoning;
    case "text":
      return undefined;
  }
}

function ToolDuration({
  callId,
  execution,
}: {
  readonly callId: string;
  readonly execution: UiToolExecution;
}): ReactElement {
  const duration = useExecutionDuration(
    callId,
    execution.executionStartedAt,
    execution.endedAt,
  );
  const abnormal =
    execution.outcome && execution.outcome !== "success"
      ? execution.outcome
      : undefined;
  return (
    <Text dimColor>
      {abnormal ? ` ⚠ ${abnormal}` : ""}
      {duration === undefined ? "" : ` · ${duration}`}
    </Text>
  );
}
