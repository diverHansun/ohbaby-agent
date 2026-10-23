import { X } from "lucide-react";
import type { ReactElement } from "react";

export interface NoticeItem {
  readonly id: string;
  readonly kind: "error" | "info";
  readonly message: string;
}

/**
 * Top-right notices for failures that happen away from where the user is looking.
 * Successful operations never produce a notice (D16).
 */
export function NoticeStack(props: {
  readonly notices: readonly NoticeItem[];
  readonly onDismiss: (id: string) => void;
}): ReactElement | null {
  if (props.notices.length === 0) return null;
  return (
    <div className="ohb-notice-stack" aria-live="polite">
      {props.notices.map((notice) => (
        <div
          key={notice.id}
          className={`ohb-notice ohb-notice-${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          <span className="ohb-notice-dot" aria-hidden="true" />
          <span className="ohb-notice-message">{notice.message}</span>
          <button
            type="button"
            className="ohb-notice-close"
            aria-label="Dismiss"
            onClick={() => {
              props.onDismiss(notice.id);
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
