import { Check, CircleAlert, CircleSlash } from "lucide-react";
import type { ReactElement } from "react";
import { Spinner } from "./Spinner.js";

/** The kinds of subagent status the chat entries and the Subagents page show. */
export type StatusTone = "working" | "approval" | "done" | "failed" | "stopped";

/**
 * One small glyph per status, so every status line has the same shape: a
 * spinner while working, the sidebar's amber dot while waiting for approval,
 * a check when done, the danger ink for failures and a dim slash when stopped.
 */
export function StatusGlyph(props: {
  readonly tone: StatusTone;
}): ReactElement {
  switch (props.tone) {
    case "working":
      return <Spinner size={10} />;
    case "approval":
      return <span className="ohb-status-dot" aria-hidden="true" />;
    case "done":
      return (
        <Check
          aria-hidden="true"
          className="ohb-status-glyph is-done"
          size={12}
          strokeWidth={2.25}
        />
      );
    case "failed":
      return (
        <CircleAlert
          aria-hidden="true"
          className="ohb-status-glyph is-failed"
          size={12}
        />
      );
    case "stopped":
      return (
        <CircleSlash
          aria-hidden="true"
          className="ohb-status-glyph is-stopped"
          size={12}
        />
      );
  }
}
