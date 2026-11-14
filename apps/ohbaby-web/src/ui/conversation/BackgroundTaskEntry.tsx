import type { UiToolCall, UiToolResult } from "ohbaby-sdk";
import { ChevronRight, Timer } from "lucide-react";
import { type ReactElement, useContext } from "react";
import { BackgroundTaskOpener } from "../shared/background-tasks.js";

/** The task a bash call started in the background, once its result says so. */
export function backgroundJobId(
  call: UiToolCall,
  result: UiToolResult | undefined,
): string | undefined {
  const details = result?.details;
  return call.name === "bash" &&
    details?.kind === "bash" &&
    details.mode === "background" &&
    details.jobId
    ? details.jobId
    : undefined;
}

/**
 * The line under a bash card that started a background task (README D7). Its
 * words never change with the task (D6); it opens the task in the right
 * panel. Transcripts without an opener (side chats) show no line.
 */
export function BackgroundTaskEntry(props: {
  readonly jobId: string;
}): ReactElement | null {
  const open = useContext(BackgroundTaskOpener);
  if (!open) return null;
  return (
    <button
      type="button"
      className="ohb-delegation-row"
      aria-label="Open background task"
      onClick={() => {
        open(props.jobId);
      }}
    >
      <Timer aria-hidden="true" className="ohb-delegation-icon" size={14} />
      <span className="ohb-delegation-copy">
        <span className="ohb-delegation-title">Background task</span>
      </span>
      <ChevronRight aria-hidden="true" size={15} />
    </button>
  );
}
