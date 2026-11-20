import { type ReactElement, useEffect, useState } from "react";
import { Banner } from "./Banner.js";

const NOTICE_VISIBLE_MS = 6_000;
const NOTICE_EXIT_MS = 200;

export interface NoticeItem {
  readonly id: string;
  readonly kind: "error" | "info";
  readonly message: string;
}

function Notice({
  notice,
  onDismiss,
}: {
  readonly notice: NoticeItem;
  readonly onDismiss: (id: string) => void;
}): ReactElement {
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;

  useEffect(() => {
    // A notice under the pointer or keyboard focus waits until it is left.
    if (held && !exiting) return;
    const timer = globalThis.setTimeout(
      () => {
        if (exiting) onDismiss(notice.id);
        else setExiting(true);
      },
      exiting ? NOTICE_EXIT_MS : NOTICE_VISIBLE_MS,
    );
    return (): void => {
      globalThis.clearTimeout(timer);
    };
  }, [exiting, held, notice.id, onDismiss]);

  return (
    <div
      className={exiting ? "ohb-notice is-exiting" : "ohb-notice"}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
      }}
    >
      <div className="ohb-notice-body">
        <Banner
          tone={notice.kind}
          message={notice.message}
          onDismiss={() => {
            setExiting(true);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Top-right notices for failures that happen away from where the user is looking.
 * Successful operations never produce a notice (D16). Same card as the inline banner.
 * Each one folds up and fades after a few seconds unless the pointer or focus rests on it.
 */
export function NoticeStack(props: {
  readonly notices: readonly NoticeItem[];
  readonly onDismiss: (id: string) => void;
}): ReactElement | null {
  if (props.notices.length === 0) return null;
  return (
    <div className="ohb-notice-stack" aria-live="polite">
      {props.notices.map((notice) => (
        <Notice key={notice.id} notice={notice} onDismiss={props.onDismiss} />
      ))}
    </div>
  );
}
