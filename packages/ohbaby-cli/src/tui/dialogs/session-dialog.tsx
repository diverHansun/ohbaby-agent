import { Box, Text, useInput } from "ink";
import type { CoreAPI } from "ohbaby-sdk";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { OverlayCard } from "../components/dialog/overlay-card.js";
import { useTuiLayout } from "../layout/context.js";
import { truncateAnsi, visibleWidth } from "../render/wrap.js";
import type {
  TuiInteractionOption,
  TuiInteractionRequest,
} from "../store/snapshot.js";
import { useTheme } from "../theme/index.js";

const SESSION_PAGE_SIZE = 10;
const SESSION_TIME_WIDTH = 11;
const ROW_MARKER_WIDTH = 2;
const ROW_GAP_WIDTH = 2;

export interface SessionDialogProps {
  readonly client: CoreAPI;
  readonly interaction: TuiInteractionRequest;
  readonly title?: string;
}

export function SessionDialog({
  client,
  interaction,
  title = "Session",
}: SessionDialogProps): ReactElement {
  const layout = useTuiLayout();
  const theme = useTheme();
  const options = interaction.options ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardWidth = Math.max(24, Math.min(88, layout.contentWidth));
  const contentWidth = Math.max(18, cardWidth - 6);
  const pageStart =
    options.length === 0
      ? 0
      : Math.floor(selectedIndex / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE;
  const pageEnd = Math.min(options.length, pageStart + SESSION_PAGE_SIZE);
  const visibleOptions = options.slice(pageStart, pageEnd);

  const selectIndex = (index: number): void => {
    const clampedIndex =
      options.length === 0 ? 0 : Math.max(0, Math.min(options.length - 1, index));
    selectedIndexRef.current = clampedIndex;
    setSelectedIndex(clampedIndex);
  };

  const selectPagedIndex = (delta: number): void => {
    selectIndex(selectedIndexRef.current + delta);
  };

  useInput((value, key) => {
    if (pending) {
      return;
    }

    const numericIndex = Number.parseInt(value, 10) - 1;

    if (
      Number.isInteger(numericIndex) &&
      numericIndex >= 0 &&
      numericIndex < options.length
    ) {
      selectIndex(numericIndex);
      return;
    }

    if (key.upArrow || key.leftArrow) {
      selectIndex(selectedIndexRef.current - 1);
      return;
    }

    if (key.downArrow || key.rightArrow || key.tab) {
      selectIndex(selectedIndexRef.current + 1);
      return;
    }

    if (key.pageUp) {
      selectPagedIndex(-SESSION_PAGE_SIZE);
      return;
    }

    if (key.pageDown) {
      selectPagedIndex(SESSION_PAGE_SIZE);
      return;
    }

    if (key.escape) {
      setPending(true);
      void client
        .respondInteraction(interaction.interactionId, {
          kind: "cancelled",
          reason: "user-cancelled",
        })
        .catch((caught: unknown) => {
          setError(formatError(caught));
          setPending(false);
        });
      return;
    }

    if (key.return && options.length > 0) {
      void client
        .respondInteraction(interaction.interactionId, {
          choiceId: options[selectedIndexRef.current]?.id,
          kind: "accepted",
        })
        .catch((caught: unknown) => {
          setError(formatError(caught));
          setPending(false);
        });
      setPending(true);
    }
  });

  return (
    <OverlayCard title={title}>
      <Box flexDirection="column">
        {visibleOptions.map((option, offset) => {
          const optionIndex = pageStart + offset;
          return (
            <SessionOptionRow
              contentWidth={contentWidth}
              key={option.id}
              option={option}
              selected={optionIndex === selectedIndex}
            />
          );
        })}
        {options.length === 0 ? <Text dimColor>No sessions</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.text.muted}>
            {formatFooter(pageStart, pageEnd, options.length)}
          </Text>
        </Box>
        {pending ? <Text dimColor>sending...</Text> : null}
        {error === null ? null : (
          <Text color={theme.status.error}>{error}</Text>
        )}
      </Box>
    </OverlayCard>
  );
}

function SessionOptionRow({
  contentWidth,
  option,
  selected,
}: {
  readonly contentWidth: number;
  readonly option: TuiInteractionOption;
  readonly selected: boolean;
}): ReactElement {
  const theme = useTheme();
  const updatedAt = formatUpdatedAt(option.metadata?.updatedAt);
  const titleWidth = Math.max(
    4,
    contentWidth -
      ROW_MARKER_WIDTH -
      ROW_GAP_WIDTH -
      Math.max(SESSION_TIME_WIDTH, visibleWidth(updatedAt)),
  );
  const title = truncateAnsi(option.label.trim() || option.id, titleWidth);
  const marker = selected ? ">" : " ";
  const color = selected ? theme.text.headingAccent : theme.text.normal;

  return (
    <Box justifyContent="space-between" width={contentWidth}>
      <Text color={color}>
        {marker} {title}
      </Text>
      <Text color={theme.text.muted}>{updatedAt}</Text>
    </Box>
  );
}

function formatFooter(start: number, end: number, total: number): string {
  if (total === 0) {
    return "showing 0 of 0 · pgup/pgdn · ↑↓";
  }
  return `showing ${String(start + 1)}-${String(end)} of ${String(
    total,
  )} · pgup/pgdn · ↑↓`;
}

function formatUpdatedAt(value: unknown): string {
  const timestamp = parseTimestamp(value);
  if (timestamp === undefined) {
    return "";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Interaction failed";
}
