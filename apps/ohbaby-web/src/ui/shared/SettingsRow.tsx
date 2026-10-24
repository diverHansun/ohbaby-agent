import type { ReactElement, ReactNode } from "react";

/**
 * One "label | value or control" line with a hairline below it (03 §4.7).
 * With `onClick` the whole row is a button; pass `control` for trailing
 * actions that must stay separate buttons (no button inside a button).
 */
export function SettingsRow(props: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly value?: ReactNode;
  readonly control?: ReactNode;
  readonly onClick?: () => void;
  readonly expanded?: boolean;
  readonly muted?: boolean;
  readonly className?: string;
  /** Text for the row button when the visible label is not enough. */
  readonly ariaLabel?: string;
}): ReactElement {
  const className = `ohb-settings-row${props.muted ? " is-muted" : ""}${
    props.onClick ? " is-clickable" : ""
  }${props.className ? ` ${props.className}` : ""}`;
  const body = (
    <>
      <span className="ohb-settings-row-label">
        <span className="ohb-settings-row-title">{props.label}</span>
        {props.description ? (
          <span className="ohb-settings-row-description">
            {props.description}
          </span>
        ) : null}
      </span>
      {props.value !== undefined ? (
        <span className="ohb-settings-row-value">{props.value}</span>
      ) : null}
    </>
  );
  return (
    <div className={className}>
      {props.onClick ? (
        <button
          type="button"
          className="ohb-settings-row-main"
          aria-expanded={props.expanded}
          aria-label={props.ariaLabel}
          onClick={props.onClick}
        >
          {body}
        </button>
      ) : (
        <div className="ohb-settings-row-main">{body}</div>
      )}
      {props.control ? (
        <span className="ohb-settings-row-control">{props.control}</span>
      ) : null}
    </div>
  );
}
