import type { ReactElement, ReactNode } from "react";

export interface MessageAction {
  readonly key: string;
  readonly node: ReactNode;
}

/**
 * The quiet icon row under a message (Claude, Codex). It shows on hover or
 * when a button inside has focus, always on touch screens, and always for
 * the latest answer. Other topics add their buttons (Edit, fork) to the list.
 */
export function MessageActions(props: {
  readonly actions: readonly MessageAction[];
  /** Keep it visible without hover, as Claude does for the latest answer. */
  readonly persistent?: boolean;
}): ReactElement | null {
  if (props.actions.length === 0) return null;
  return (
    <div
      className={`ohb-message-actions${props.persistent ? " is-persistent" : ""}`}
      role="group"
      aria-label="Message actions"
    >
      {props.actions.map((action) => (
        <span key={action.key} className="ohb-message-action">
          {action.node}
        </span>
      ))}
    </div>
  );
}
