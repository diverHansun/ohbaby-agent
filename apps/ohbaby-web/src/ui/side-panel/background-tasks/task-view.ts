import {
  formatDurationSeconds,
  type UiShellJobOutput,
  type UiShellJobRow,
} from "ohbaby-sdk";

/** The backend returns at most this much of a task's output tail. */
export const OUTPUT_TAIL_BYTES = 32_768;

export type TaskGroup = "running" | "done";

/** What a list row shows at its right edge (03 §5.2): time, or a failure word. */
export type TaskTrailing =
  | { readonly kind: "time"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "unknown"; readonly text: string };

/** The description, else the command's first line. */
export function taskTitle(row: UiShellJobRow): string {
  const description = row.description?.trim();
  if (description) return description;
  return row.command.split("\n", 1)[0]?.trim() || row.command;
}

export function taskGroup(row: UiShellJobRow): TaskGroup {
  return row.status === "running" ? "running" : "done";
}

/** Cancel shows only for running tasks the backend lets this window stop (00 §4). */
export function canCancel(row: UiShellJobRow): boolean {
  return row.status === "running" && row.canStop;
}

/** Started from another ohbaby backend; only meaningful while running (01 §1.3). */
export function managedElsewhere(row: UiShellJobRow): boolean {
  return (
    row.status === "running" && !row.canStop && !row.managedByCurrentBackend
  );
}

function startOf(row: UiShellJobRow): number {
  return row.startedAt ?? row.createdAt;
}

/** Milliseconds the task ran, or has run so far. */
export function taskElapsed(row: UiShellJobRow, now: number): number {
  const end = row.status === "running" ? now : (row.endedAt ?? now);
  return Math.max(0, end - startOf(row));
}

/** Compact time for list rows: `45s`, `12m`, `2h 5m`. */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(rest)}m`;
}

/** Full time for the detail's status line: `12m 4s`. */
function longDuration(ms: number): string {
  return formatDurationSeconds(ms / 1000);
}

export function taskTrailing(row: UiShellJobRow, now: number): TaskTrailing {
  if (row.status === "failed") return { kind: "failed", text: "Failed" };
  if (row.status === "timed_out") return { kind: "failed", text: "Timed out" };
  if (row.status === "lost") return { kind: "unknown", text: "Unknown" };
  return { kind: "time", text: shortDuration(taskElapsed(row, now)) };
}

/** The detail's status line (03 §5.2). */
export function taskStatusLine(row: UiShellJobRow, now: number): string {
  const time = longDuration(taskElapsed(row, now));
  switch (row.status) {
    case "running":
      return `Running · ${time}`;
    case "completed":
      return `Completed · exit ${String(row.exitCode ?? 0)} · ${time}`;
    case "failed":
      if (row.signal) return `Failed · ${row.signal} · ${time}`;
      return row.exitCode === null
        ? `Failed · ${time}`
        : `Failed · exit ${String(row.exitCode)} · ${time}`;
    case "timed_out":
      return `Timed out · ${time}`;
    case "cancelled":
      if (row.stopReason === "user") return `Cancelled by you · ${time}`;
      if (row.stopReason === "model") return `Cancelled by the agent · ${time}`;
      return `Cancelled · ${time}`;
    case "lost":
      return "Result unknown";
  }
}

const STOP_NOTES: Partial<
  Record<NonNullable<UiShellJobRow["stopReason"]>, string>
> = {
  "owner-ended": "Stopped when its subagent finished.",
  rewound: "Stopped when the chat was rewound.",
  "output-limit": "Stopped after writing too much output.",
  "capacity-limit": "Stopped because too many tasks were running.",
  shutdown: "Stopped when ohbaby shut down.",
  "session-closed": "Stopped when the chat was closed.",
  "internal-error": "Stopped by an internal error.",
};

/** Up to two quiet explanation lines for the detail, in 03 §5.3 order. */
export function taskNotes(row: UiShellJobRow): readonly string[] {
  const notes: string[] = [];
  if (managedElsewhere(row))
    notes.push("Started from another ohbaby window. Cancel it there.");
  if (row.cleanup === "unconfirmed" && row.trackingReleasedAt === null)
    notes.push(
      "ohbaby couldn't confirm the process stopped. It may still be running.",
    );
  if (row.status === "lost")
    notes.push("ohbaby stopped unexpectedly while this task was running.");
  const stop = row.stopReason ? STOP_NOTES[row.stopReason] : undefined;
  if (stop && row.status !== "running") notes.push(stop);
  return notes.slice(0, 2);
}

export interface TaskOutputView {
  readonly text: string;
  /** Only the last 32 KB came back. */
  readonly tailOnly: boolean;
  /** The saved log itself stopped at its size limit. */
  readonly logIncomplete: boolean;
  readonly logPath?: string;
  /** This task kept no output tail (e.g. a foreground command). */
  readonly noSavedOutput: boolean;
}

export function taskOutputView(output: UiShellJobOutput): TaskOutputView {
  return {
    text: output.output,
    tailOnly: output.outputBytes > OUTPUT_TAIL_BYTES,
    logIncomplete: output.outputTruncated,
    ...(output.logPath ? { logPath: output.logPath } : {}),
    noSavedOutput: !output.tailAvailable,
  };
}

/** Counts from the backend, independent of how many pages are loaded. */
export function groupCounts(
  counts: Readonly<Record<UiShellJobRow["status"], number>>,
): Record<TaskGroup, number> {
  const done =
    counts.completed +
    counts.failed +
    counts.timed_out +
    counts.cancelled +
    counts.lost;
  return { running: counts.running, done };
}

/** Total tasks in one owner scope. */
export function totalCount(
  counts: Readonly<Record<UiShellJobRow["status"], number>>,
): number {
  const { running, done } = groupCounts(counts);
  return running + done;
}
