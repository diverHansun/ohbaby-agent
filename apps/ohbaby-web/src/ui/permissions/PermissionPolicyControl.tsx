import { Hand, ShieldAlert } from "lucide-react";
import type { UiPermissionLevel } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function FullAccessConfirmDialog(props: {
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

export function PermissionPolicyControl(props: {
  readonly level: UiPermissionLevel;
  readonly disabled: boolean;
  readonly onSetPermission: (input: {
    readonly level: UiPermissionLevel;
  }) => void;
}): ReactElement {
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const permissionButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnPermissionFocusRef = useRef(false);
  const cyclePermissionLevel = useCallback(() => {
    if (props.level === "default") {
      setFullAccessConfirmOpen(true);
      return;
    }
    props.onSetPermission({ level: "default" });
  }, [props.onSetPermission, props.level]);

  const dismissFullAccessConfirm = useCallback((): void => {
    returnPermissionFocusRef.current = true;
    setFullAccessConfirmOpen(false);
  }, []);

  const confirmFullAccess = useCallback((): void => {
    returnPermissionFocusRef.current = true;
    setFullAccessConfirmOpen(false);
    props.onSetPermission({ level: "full-access" });
  }, [props.onSetPermission]);

  useLayoutEffect(() => {
    if (!fullAccessConfirmOpen && returnPermissionFocusRef.current) {
      returnPermissionFocusRef.current = false;
      permissionButtonRef.current?.focus();
    }
  }, [fullAccessConfirmOpen]);

  return (
    <>
      <button
        aria-label={
          props.level === "default"
            ? "Permission policy: default. Ask before protected actions. Click to enable full-access without approval prompts."
            : "Permission policy: full-access. Run without approval prompts. Click to return to default."
        }
        className={`ohb-permission-toggle ohb-permission-${props.level}`}
        disabled={props.disabled}
        onClick={cyclePermissionLevel}
        ref={permissionButtonRef}
        title={
          props.level === "default"
            ? "Default: ask before protected actions. Click for full-access."
            : "Full-access: run without approval prompts. Click for default."
        }
        type="button"
      >
        {props.level === "default" ? (
          <Hand aria-hidden="true" size={17} />
        ) : (
          <ShieldAlert aria-hidden="true" size={17} />
        )}
      </button>
      {fullAccessConfirmOpen ? (
        <FullAccessConfirmDialog
          onConfirm={confirmFullAccess}
          onDismiss={dismissFullAccessConfirm}
        />
      ) : null}
    </>
  );
}
