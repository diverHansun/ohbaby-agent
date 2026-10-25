import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

export function fieldErrorId(id: string): string {
  return `${id}-error`;
}

/**
 * A form line: label on the left, control and its error underneath on the
 * right (03 §4.7). The control should point `aria-describedby` at
 * `fieldErrorId(id)` while `error` is set.
 */
export function FieldRow(props: {
  readonly id: string;
  readonly label: string;
  /** Units or format, shown after the label in dim text. */
  readonly hint?: string;
  readonly error?: string;
  /** A fix for the error, e.g. Restore for a value that cannot be cleared. */
  readonly errorAction?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className={`ohb-field-row${props.error ? " is-invalid" : ""}`}>
      <label className="ohb-field-label" htmlFor={props.id}>
        {props.label}
        {props.hint ? (
          <span className="ohb-field-hint">{props.hint}</span>
        ) : null}
      </label>
      <div className="ohb-field-control">
        {props.children}
        {props.error ? (
          <p id={fieldErrorId(props.id)} className="ohb-field-error">
            {props.error}
            {props.errorAction}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A collapsed group of less common fields (`More options`). */
export function MoreOptions(props: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ohb-more-options">
      <button
        type="button"
        className="ohb-more-options-toggle"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={`ohb-more-options-chevron${props.open ? " is-open" : ""}`}
        />
        More options
      </button>
      {props.open ? (
        <div className="ohb-more-options-body">{props.children}</div>
      ) : null}
    </div>
  );
}
