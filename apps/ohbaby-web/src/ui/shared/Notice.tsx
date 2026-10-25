import type { ReactElement } from "react";
import { Banner } from "./Banner.js";
import { readableError } from "./error-text.js";

export interface NoticeItem {
  readonly id: string;
  readonly kind: "error" | "info";
  readonly message: string;
}

/**
 * Top-right notices for failures that happen away from where the user is looking.
 * Successful operations never produce a notice (D16). Same card as the inline banner.
 */
export function NoticeStack(props: {
  readonly notices: readonly NoticeItem[];
  readonly onDismiss: (id: string) => void;
}): ReactElement | null {
  if (props.notices.length === 0) return null;
  return (
    <div className="ohb-notice-stack" aria-live="polite">
      {props.notices.map((notice) => (
        <Banner
          key={notice.id}
          tone={notice.kind}
          message={readableError(notice.message)}
          onDismiss={() => {
            props.onDismiss(notice.id);
          }}
        />
      ))}
    </div>
  );
}
