import type { ReactElement } from "react";

/**
 * A plain text button (README D2): background tasks can only be cancelled, so
 * it says so instead of showing a stop square or a pill. It keeps its width
 * while it reads `Cancelling…`.
 */
export function TaskCancelButton(props: {
  readonly title: string;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="ohb-bgtask-cancel"
      disabled={props.cancelling}
      aria-label={
        props.cancelling ? `Cancelling ${props.title}` : `Cancel ${props.title}`
      }
      onClick={(event) => {
        event.stopPropagation();
        props.onCancel();
      }}
    >
      {/* Both labels share one grid cell, so the width never changes (04 §1.1). */}
      <span className="ohb-bgtask-cancel-labels" aria-hidden="true">
        <span className={props.cancelling ? "is-hidden" : undefined}>
          Cancel
        </span>
        <span className={props.cancelling ? undefined : "is-hidden"}>
          Cancelling…
        </span>
      </span>
    </button>
  );
}
