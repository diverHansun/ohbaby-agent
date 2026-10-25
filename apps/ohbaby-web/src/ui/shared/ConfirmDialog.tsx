import type { ReactElement } from "react";
import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { trapTab } from "./focus-trap.js";

/**
 * A small modal question with Cancel and a confirm button. Focus starts on
 * Cancel (04 §3); Escape and Cancel dismiss; focus returns to whatever was
 * focused before it opened. It sits above menus and the settings dialog.
 */
export function ConfirmDialog(props: {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  /** A destructive action shows its confirm button as danger text. */
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelRef.current?.focus();
    return (): void => {
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="ohb-confirm-layer" role="presentation">
      <section
        ref={dialogRef}
        className="ohb-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descriptionId : undefined}
        onKeyDown={(event) => {
          // Portaled, but React still bubbles keys to the dialog underneath.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (!props.busy) props.onCancel();
            return;
          }
          trapTab(event, dialogRef.current);
        }}
      >
        <h2 id={titleId}>{props.title}</h2>
        {props.description ? (
          <p id={descriptionId}>{props.description}</p>
        ) : null}
        {props.error ? (
          <p className="ohb-confirm-error" role="alert">
            {props.error}
          </p>
        ) : null}
        <div className="ohb-confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="ohb-text-button"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={
              props.danger ? "ohb-text-button is-danger" : "ohb-primary-button"
            }
            aria-busy={props.busy}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
