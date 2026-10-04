import { Box, Static, Text, useStdout } from "ink";
import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { UiMessage } from "ohbaby-sdk";
import type { TranscriptItem } from "../../store/transcript.js";
import { LiveTailRefContext, useTuiLayout } from "../../layout/context.js";
import { useTheme } from "../../theme/index.js";
import {
  MessageParts,
  renderMessageParts,
  type RenderedPart,
  type RenderedTextSegment,
} from "../message/message-row.js";
import { PromptCompletion } from "./prompt-completion.js";
import { LiveTail } from "./live-tail.js";

const CLEAR_TRANSCRIPT = "\u001b[2J\u001b[3J\u001b[H";
// A small mutable suffix absorbs normal Markdown wrapping while finished rows
// become native terminal scrollback, even before a long text part finishes.
const STREAM_TAIL_ROWS = 4;

interface CachedRow {
  readonly part: RenderedPart;
  readonly fingerprint: string;
}

interface ProjectedRow {
  readonly id: string;
  readonly message: UiMessage;
  readonly part?: RenderedPart;
  readonly promptCompletion?: TranscriptItem["promptCompletion"];
  readonly fingerprint: string;
}

/** Append stable output; replace it only when its visible prefix changes. */
export function ReplayableTranscript({
  items,
  identity,
  toolsExpanded = false,
  liveMessage,
  children,
}: {
  readonly children?: ReactNode;
  readonly items: readonly TranscriptItem[];
  readonly identity?: string;
  readonly toolsExpanded?: boolean;
  readonly liveMessage?: UiMessage | null;
}): ReactElement {
  const layout = useTuiLayout();
  const liveTailRef = useContext(LiveTailRefContext);
  const theme = useTheme();
  const { write } = useStdout();
  const [generation, setGeneration] = useState(0);
  const previous = useRef<
    | {
        readonly identity?: string;
        readonly liveMessage?: UiMessage | null;
        readonly toolsExpanded: boolean;
        readonly committedRowCount: number;
        readonly width: number;
        readonly fingerprints: readonly string[];
        readonly rows: ProjectedRow[];
      }
    | undefined
  >(undefined);
  const projections = useMemo(
    () => new WeakMap<UiMessage, readonly CachedRow[]>(),
    [layout.contentWidth, theme, toolsExpanded],
  );
  const project = (message: UiMessage): readonly CachedRow[] => {
    const cached = projections.get(message);
    if (cached) return cached;
    const rows = renderMessageParts(
      message,
      Math.max(1, layout.contentWidth - (message.role === "user" ? 2 : 0)),
      theme,
      undefined,
      toolsExpanded,
    )
      .flatMap(splitPartRows)
      .map((part) => ({
        part,
        fingerprint: JSON.stringify({ role: message.role, part }),
      }));
    projections.set(message, rows);
    return rows;
  };
  const rows: ProjectedRow[] = [];
  const lineCounts = new Map<string, number>();
  const append = (
    message: UiMessage,
    messageId: string,
    cached?: CachedRow,
    promptCompletion?: TranscriptItem["promptCompletion"],
  ): void => {
    const index = lineCounts.get(messageId) ?? 0;
    lineCounts.set(messageId, index + 1);
    const id = `${messageId}:row:${String(index)}`;
    rows.push({
      id,
      message,
      part: cached?.part,
      promptCompletion,
      fingerprint: `${id}:${cached?.fingerprint ?? (promptCompletion ? JSON.stringify(promptCompletion) : "blank")}`,
    });
  };
  for (const item of items) {
    if (item.promptCompletion) {
      append(item.message, item.messageId, undefined, item.promptCompletion);
    } else {
      for (const part of project(item.message))
        append(item.message, item.messageId, part);
      if (item.spacing) append(item.message, item.messageId);
    }
  }
  const committedRowCount = rows.length;
  // Tools remain in the normal live renderer until their facts are sealed by
  // the store. Do not freeze pending status, elapsed timers or partial output.
  const streamsText =
    liveMessage?.role === "assistant" &&
    liveMessage.parts.every(
      (part) => part.type === "text" || part.type === "reasoning",
    );
  let tail: readonly RenderedPart[] = [];
  if (liveMessage && streamsText) {
    const projected = project(liveMessage);
    const staticCount = Math.max(0, projected.length - STREAM_TAIL_ROWS);
    for (const part of projected.slice(0, staticCount))
      append(liveMessage, liveMessage.id, part);
    tail = projected.slice(staticCount).map((row) => row.part);
  }
  const tailBudget = Math.max(0, layout.liveTailRows - (liveTailRef ? 1 : 0));
  const fingerprints = rows.map((row) => row.fingerprint);
  const old = previous.current;
  const changedIndex =
    old?.fingerprints.findIndex(
      (fingerprint, index) => fingerprint !== fingerprints[index],
    ) ?? -1;
  // Appended Markdown can reflow earlier table columns or list spacing. Keep
  // that provisional prefix readable, and reconcile once the text is sealed.
  // Appending by the new row indices here would duplicate or skip wrapped text.
  const deferReflow =
    old !== undefined &&
    changedIndex >= committedRowCount &&
    changedIndex >= old.committedRowCount &&
    old.identity === identity &&
    old.width === layout.contentWidth &&
    old.toolsExpanded === toolsExpanded &&
    isAppendOnlyLiveText(old.liveMessage, liveMessage) &&
    old.rows
      .slice(changedIndex)
      .every((row) => row.message.id === liveMessage?.id) &&
    rows.slice(changedIndex).every((row) => row.message.id === liveMessage?.id);
  const showReflowNotice = deferReflow && tailBudget >= 2;
  const textRows = Math.max(0, tailBudget - (showReflowNotice ? 1 : 0));
  tail = textRows > 0 ? tail.slice(-textRows) : [];
  const nextRows = deferReflow ? old.rows : rows;
  const nextFingerprints = deferReflow ? old.fingerprints : fingerprints;
  const needsReplay =
    old !== undefined &&
    !deferReflow &&
    (old.identity !== identity ||
      old.width !== layout.contentWidth ||
      changedIndex >= 0);
  // Static appends during Ink's commit. Do not hand it the longer replacement
  // before the layout effect clears/rekeys it, or it prints a spurious suffix.
  const staticRows = needsReplay ? old.rows : nextRows;
  useLayoutEffect(() => {
    previous.current = {
      identity,
      width: layout.contentWidth,
      fingerprints: nextFingerprints,
      rows: nextRows,
      liveMessage,
      toolsExpanded,
      committedRowCount,
    };
    if (!needsReplay) return;
    write(CLEAR_TRANSCRIPT);
    setGeneration((value) => value + 1);
  }, [
    nextFingerprints,
    committedRowCount,
    identity,
    layout.contentWidth,
    needsReplay,
    nextRows,
    liveMessage,
    toolsExpanded,
    write,
  ]);

  return (
    <>
      <Static key={generation} items={staticRows}>
        {(row): ReactElement =>
          row.promptCompletion ? (
            <PromptCompletion key={row.id} prompt={row.promptCompletion} />
          ) : row.part ? (
            <Box key={row.id}>
              <MessageParts message={row.message} parts={[row.part]} />
            </Box>
          ) : (
            <Box key={row.id} height={1} />
          )
        }
      </Static>
      {children}
      {liveMessage && streamsText ? (
        <Box
          ref={liveTailRef}
          flexDirection="column"
          marginBottom={liveTailRef ? 0 : 1}
          paddingBottom={liveTailRef && layout.liveTailRows > 0 ? 1 : 0}
          maxHeight={layout.liveTailRows}
          overflow="hidden"
        >
          {showReflowNotice ? (
            <Text dimColor wrap="truncate-end">
              … text pending final layout
            </Text>
          ) : null}
          {tail.map((part, index) =>
            deferReflow &&
            tailBudget === 1 &&
            layout.contentWidth > 2 &&
            part.kind === "text" ? (
              <Box key={index}>
                <Text dimColor>… </Text>
                <Box width={layout.contentWidth - 2}>
                  <Text wrap="truncate-start">{part.text}</Text>
                </Box>
              </Box>
            ) : (
              <MessageParts key={index} message={liveMessage} parts={[part]} />
            ),
          )}
        </Box>
      ) : liveMessage ? (
        <LiveTail message={liveMessage} toolsExpanded={toolsExpanded} />
      ) : null}
    </>
  );
}

/** Only source append/equivalence may defer layout; edits still correct now. */
function isAppendOnlyLiveText(
  previous: UiMessage | null | undefined,
  next: UiMessage | null | undefined,
): boolean {
  if (!previous || !next) return false;
  return (
    previous.id === next.id &&
    previous.status === "streaming" &&
    next.status === "streaming" &&
    previous.parts.length === next.parts.length &&
    previous.parts.every((part, index) => {
      const current = next.parts[index];
      return (
        (part.type === "text" || part.type === "reasoning") &&
        current.type === part.type &&
        (index === previous.parts.length - 1
          ? current.text.startsWith(part.text)
          : current.text === part.text)
      );
    })
  );
}

/** Preserve per-segment tool colors when a rendered part spans terminal rows. */
function splitPartRows(part: RenderedPart): readonly RenderedPart[] {
  const text = part.kind === "spinner" ? part.label : part.text;
  let segmentsByLine: RenderedTextSegment[][] | undefined;
  if (part.segments) {
    let currentLine: RenderedTextSegment[] = [];
    segmentsByLine = [currentLine];
    for (const segment of part.segments) {
      const lines = segment.text.split("\n");
      for (const [index, line] of lines.entries()) {
        if (index > 0) {
          currentLine = [];
          segmentsByLine.push(currentLine);
        }
        if (line !== "") currentLine.push({ ...segment, text: line });
      }
    }
  }
  return text.split("\n").map((line, index) => ({
    ...part,
    index: 0,
    execution: index === 0 ? part.execution : undefined,
    ...(part.kind === "spinner" ? { label: line } : { text: line }),
    segments: segmentsByLine?.[index],
  }));
}
