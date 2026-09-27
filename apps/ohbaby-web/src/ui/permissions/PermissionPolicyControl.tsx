import { ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function FullAccessConfirmDialog(props: {
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const app = document.querySelector(".ohb-app");
    const wasInert = app?.hasAttribute("inert") ?? false;
    app?.setAttribute("inert", "");
    return (): void => {
      if (!wasInert) {
        app?.removeAttribute("inert");
      }
    };
  }, []);

  return createPortal(
    <div
      className="ohb-full-access-layer"
      onClick={props.onDismiss}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss();
          return;
        }
        if (event.key !== "Tab") {
          return;
        }
        if (event.shiftKey && document.activeElement === cancelRef.current) {
          event.preventDefault();
          confirmRef.current?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === confirmRef.current
        ) {
          event.preventDefault();
          cancelRef.current?.focus();
        }
      }}
      role="presentation"
    >
      <section
        aria-describedby="ohb-full-access-description"
        aria-labelledby="ohb-full-access-title"
        aria-modal="true"
        className="ohb-full-access-dialog"
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
      >
        <div className="ohb-full-access-heading">
          <span aria-hidden="true" className="ohb-full-access-icon">
            <ShieldAlert size={18} />
          </span>
          <h2 id="ohb-full-access-title">Enable full access?</h2>
        </div>
        <p id="ohb-full-access-description">
          When enabled, the agent skips confirmations for subsequent actions and
          may run commands, access the network, or modify workspace files. You
          can switch back to the default permission at any time.
        </p>
        <div className="ohb-full-access-actions">
          <button
            className="ohb-full-access-cancel"
            onClick={props.onDismiss}
            ref={cancelRef}
            title="Not now"
            type="button"
          >
            Not now
          </button>
          <button
            className="ohb-full-access-confirm"
            onClick={props.onConfirm}
            ref={confirmRef}
            title="Use full access"
            type="button"
          >
            <ShieldAlert aria-hidden="true" size={15} />
            Use full access
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
