import {
  canCancel,
  groupCounts,
  taskGroup,
  taskNotes,
  taskOutputView,
  taskStatusLine,
  taskTitle,
  taskTrailing,
  type UiShellJobListMeta,
  type UiShellJobOutput,
  type UiShellJobRow,
} from "ohbaby-sdk";
import { truncateAnsi, visibleWidth, wrapAnsi } from "../../render/wrap.js";

/**
 * Pure, width-first rendering in the spirit of pi-tui's `render(width)`: every
 * function returns finished rows that never exceed `width`, and the Ink
 * component only prints them. Tones map to theme colors at the edge.
 */
export type Tone = "normal" | "dim" | "accent" | "error" | "warning" | "bold";
export interface Segment {
  readonly text: string;
  readonly tone?: Tone;
}
export type Line = readonly Segment[];

/** Fixed width of the right column, sized for `Cancelling…` (03 §4.2). */
export const TRAILING_WIDTH = 11;
/** Below this content width the command column is left out (03 §5). */
export const COMMAND_MIN_WIDTH = 60;
/** Below this content width, or 10 rows, only "too small" shows (03 §5). */
export const PANEL_MIN_WIDTH = 40;
export const PANEL_MIN_ROWS = 10;
const COMMAND_MAX_ROWS = 3;
const OWNER_MAX = 18;

export type OwnerFilter = "main" | "subagents" | "all";
const FILTER_LABELS: Record<OwnerFilter, string> = {
  main: "Main agent",
  subagents: "Subagents",
  all: "All",
};
const EMPTY_TEXT: Record<OwnerFilter, string> = {
  main: "No tasks from the main agent.",
  subagents: "No tasks from subagents.",
  all: "No background tasks in this chat.",
};

function cut(text: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(text) <= width ? text : truncateAnsi(text, width);
}
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}
export function lineText(line: Line): string {
  return line.map((segment) => segment.text).join("");
}

/** One row: `›`, description, command, owner, then the fixed right column. */
export function taskRowLine(input: {
  readonly row: UiShellJobRow;
  readonly now: number;
  readonly width: number;
  readonly selected: boolean;
  readonly showOwner: boolean;
  readonly cancelling: boolean;
}): Line {
  const { row, width } = input;
  const trailing = input.cancelling
    ? { kind: "time" as const, text: "Cancelling…" }
    : taskTrailing(row, input.now);
  const avail = Math.max(1, width - 2 - 1 - TRAILING_WIDTH);
  const owner =
    input.showOwner && row.ownerKind === "subagent"
      ? `  ${cut(row.ownerName, OWNER_MAX)}`
      : "";
  const showCommand = width >= COMMAND_MIN_WIDTH;
  const title = cut(
    taskTitle(row),
    Math.max(1, avail - visibleWidth(owner) - (showCommand ? 10 : 0)),
  );
  const rest = avail - visibleWidth(title) - visibleWidth(owner);
  const command =
    showCommand && rest > 4 ? `  ${cut(firstLine(row.command), rest - 2)}` : "";
  const filler = Math.max(
    0,
    avail - visibleWidth(title) - visibleWidth(command) - visibleWidth(owner),
  );
  const rowTone: Tone | undefined = input.selected ? "accent" : undefined;
  return [
    { text: input.selected ? "› " : "  ", tone: rowTone },
    { text: title, tone: rowTone ?? "normal" },
    { text: command, tone: input.selected ? "accent" : "dim" },
    { text: owner, tone: input.selected ? "accent" : "dim" },
    { text: " ".repeat(filler + 1) },
    {
      text: trailing.text.padStart(TRAILING_WIDTH),
      tone:
        trailing.kind === "failed"
          ? "error"
          : input.selected
            ? "accent"
            : "dim",
    },
  ];
}

export interface ListModel {
  /** Rows in display order: Running group, then Done. */
  readonly rows: readonly UiShellJobRow[];
  readonly lines: readonly Line[];
  /** Index into `lines` of each row, for scrolling the selection into view. */
  readonly rowLine: readonly number[];
}

/** The list body: group titles with backend counts, then rows (03 §4.2). */
export function taskListModel(input: {
  readonly rows: readonly UiShellJobRow[];
  readonly meta?: UiShellJobListMeta;
  readonly now: number;
  readonly width: number;
  readonly selected: number;
  readonly filter: OwnerFilter;
  readonly cancelling: ReadonlySet<string>;
}): ListModel {
  const running = input.rows.filter((row) => taskGroup(row) === "running");
  const done = input.rows.filter((row) => taskGroup(row) === "done");
  const ordered = [...running, ...done];
  if (ordered.length === 0 && !input.meta?.hasMore)
    return {
      rows: [],
      lines: [[{ text: EMPTY_TEXT[input.filter], tone: "dim" }]],
      rowLine: [],
    };
  const counts = input.meta
    ? groupCounts(input.meta.statusCounts)
    : { running: running.length, done: done.length };
  const lines: Line[] = [];
  const rowLine: number[] = [];
  const group = (
    title: string,
    count: number,
    rows: readonly UiShellJobRow[],
  ): void => {
    lines.push([{ text: `${title} ${String(count)}`, tone: "dim" }]);
    if (rows.length === 0) lines.push([{ text: "  None", tone: "dim" }]);
    for (const row of rows) {
      const index = rowLine.length;
      rowLine.push(lines.length);
      lines.push(
        taskRowLine({
          row,
          now: input.now,
          width: input.width,
          selected: index === input.selected,
          showOwner: input.filter !== "main",
          cancelling: input.cancelling.has(row.jobId),
        }),
      );
    }
  };
  group("Running", counts.running, running);
  group("Done", counts.done, done);
  return { rows: ordered, lines, rowLine };
}

export function panelTitle(filter: OwnerFilter, filterable: boolean): Line {
  return [
    { text: "Background tasks", tone: "bold" },
    ...(filterable
      ? [{ text: ` · ${FILTER_LABELS[filter]}`, tone: "dim" as const }]
      : []),
  ];
}

/** Only the keys that work right now (04 §1.3). */
export function keyLine(input: {
  readonly view: "list" | "detail";
  readonly canCancel: boolean;
  readonly canAbandon?: boolean;
  readonly filterable: boolean;
  readonly following: boolean;
  readonly retry: boolean;
}): Line {
  const keys =
    input.view === "list"
      ? [
          "↑/↓ select",
          "Enter open",
          ...(input.canCancel ? ["c cancel"] : []),
          ...(input.canAbandon ? ["u stop tracking"] : []),
          ...(input.filterable ? ["f filter"] : []),
          ...(input.retry ? ["r retry"] : []),
          "Esc close",
        ]
      : [
          "↑/↓ scroll",
          ...(input.following ? [] : ["End follow"]),
          ...(input.canCancel ? ["c cancel"] : []),
          ...(input.canAbandon ? ["u stop tracking"] : []),
          ...(input.retry ? ["r retry"] : []),
          "Esc back",
        ];
  return [{ text: keys.join(" · "), tone: "dim" }];
}

export function confirmLine(
  title: string,
  width: number,
  verb = "Cancel",
): Line {
  const suffix = "? y confirm · any key back";
  return [
    {
      text: `${verb} ${cut(title, Math.max(4, width - verb.length - 1 - suffix.length))}${suffix}`,
      tone: "warning",
    },
  ];
}

/** The detail header (03 §4.3): title and status, command (≤ 3 rows), notes. */
export function detailHeader(input: {
  readonly row: UiShellJobRow;
  readonly now: number;
  readonly width: number;
  readonly cancelling: boolean;
}): Line[] {
  const { row, width } = input;
  const status = input.cancelling
    ? "Cancelling…"
    : taskStatusLine(row, input.now);
  const statusWidth = visibleWidth(status);
  const title = cut(taskTitle(row), Math.max(1, width - statusWidth - 2));
  const failed = row.status === "failed" || row.status === "timed_out";
  const lines: Line[] = [
    [
      { text: title, tone: "bold" },
      {
        text: " ".repeat(
          Math.max(2, width - visibleWidth(title) - statusWidth),
        ),
      },
      { text: status, tone: failed ? "error" : "dim" },
    ],
  ];
  const command = wrapAnsi(row.command, width);
  const shown = command.slice(0, COMMAND_MAX_ROWS);
  if (command.length > COMMAND_MAX_ROWS) {
    const last = shown[COMMAND_MAX_ROWS - 1] ?? "";
    shown[COMMAND_MAX_ROWS - 1] = `${cut(last, width - 1)}…`;
  }
  for (const text of shown) lines.push([{ text, tone: "dim" }]);
  if (row.ownerKind === "subagent")
    lines.push([
      { text: cut(`Started by ${row.ownerName}`, width), tone: "dim" },
    ]);
  for (const note of taskNotes(row))
    for (const text of wrapAnsi(note, width))
      lines.push([{ text, tone: "dim" }]);
  return lines;
}

/** Output rows below the rule; notes about a cut tail come first (03 §4.3). */
export function outputLines(
  output: UiShellJobOutput | undefined,
  ended: boolean,
  width: number,
): Line[] {
  if (!output) return [];
  const view = taskOutputView(output);
  if (view.noSavedOutput && ended)
    return [[{ text: "No output was saved for this task.", tone: "dim" }]];
  const lines: Line[] = [];
  if (view.tailOnly)
    lines.push([{ text: "Showing the last 32 KB.", tone: "dim" }]);
  if (view.logPath)
    if (view.tailOnly || view.logIncomplete)
      for (const text of wrapAnsi(`Log: ${view.logPath}`, width))
        lines.push([{ text, tone: "dim" }]);
  if (view.logIncomplete)
    lines.push([
      {
        text: cut(
          "The saved log is incomplete because the output was too large.",
          width,
        ),
        tone: "dim",
      },
    ]);
  if (view.text === "") {
    if (ended) lines.push([{ text: "No output.", tone: "dim" }]);
    return lines;
  }
  for (const text of wrapAnsi(view.text.replace(/\n$/u, ""), width))
    lines.push([{ text }]);
  return lines;
}

export function canCancelRow(row: UiShellJobRow | undefined): boolean {
  return row !== undefined && canCancel(row);
}
