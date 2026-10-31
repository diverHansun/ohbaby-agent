import { Check, Hand, ShieldAlert } from "lucide-react";
import type { UiPermissionLevel } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu, type MenuAnchor } from "../shared/Menu.js";

/** The existing full-access confirmation; the phone More menu reuses it (D29). */
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
    const app = document.querySelector(".ohb-shell");
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
          can switch back to Ask for approval at any time.
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

const PERMISSION_MODES = [
  {
    level: "default",
    label: "Ask for approval",
    description: "Ask before running commands or editing files",
    Icon: Hand,
  },
  {
    level: "full-access",
    label: "Full access",
    description: "Run commands and edit files without asking",
    Icon: ShieldAlert,
  },
] as const satisfies readonly {
  readonly level: UiPermissionLevel;
  readonly label: string;
  readonly description: string;
  readonly Icon: typeof Hand;
}[];

/**
 * The permission pill in the composer row: it names the current mode, and
 * opens a small card listing each mode with one line on what it allows
 * (after the Codex and Claude app pickers). Full access still asks first.
 */
export function PermissionPolicyControl(props: {
  readonly level: UiPermissionLevel;
  readonly disabled: boolean;
  readonly onSetPermission: (input: {
    readonly level: UiPermissionLevel;
  }) => void;
}): ReactElement {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const permissionButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnPermissionFocusRef = useRef(false);
  const current =
    PERMISSION_MODES.find((mode) => mode.level === props.level) ??
    PERMISSION_MODES[0];

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setAnchor(null);
    if (restoreFocus) {
      permissionButtonRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const choose = (level: UiPermissionLevel): void => {
    if (level === "full-access" && props.level !== level) {
      closeMenu(false);
      setFullAccessConfirmOpen(true);
      return;
    }
    closeMenu(true);
    if (level !== props.level) props.onSetPermission({ level });
  };

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
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Permissions: ${current.label}`}
        className={`ohb-permission-button ohb-permission-${props.level}`}
        disabled={props.disabled}
        onClick={(event) => {
          if (anchor) {
            closeMenu(false);
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          setAnchor({
            x: bounds.left,
            y: bounds.bottom + 6,
            aboveY: bounds.top - 6,
            alignRight: false,
          });
        }}
        ref={permissionButtonRef}
        title={current.description}
        type="button"
      >
        <current.Icon aria-hidden="true" size={14} strokeWidth={1.75} />
        <span>{current.label}</span>
      </button>
      {anchor ? (
        <Menu
          anchor={anchor}
          className="ohb-permission-menu"
          focusSelector="[aria-current='true']"
          triggerRef={permissionButtonRef}
          label="Permissions"
          onClose={closeMenu}
        >
          <div className="ohb-permission-menu-heading" aria-hidden="true">
            Permissions · this chat
          </div>
          {PERMISSION_MODES.map((mode) => {
            const active = mode.level === props.level;
            return (
              <button
                aria-current={active ? "true" : undefined}
                className={
                  mode.level === "full-access" ? "is-danger" : undefined
                }
                key={mode.level}
                onClick={() => {
                  choose(mode.level);
                }}
                role="menuitem"
                type="button"
              >
                <mode.Icon
                  aria-hidden="true"
                  className="ohb-permission-menu-icon"
                  size={15}
                  strokeWidth={1.75}
                />
                <span className="ohb-permission-menu-text">
                  <span className="ohb-permission-menu-label">
                    {mode.label}
                  </span>
                  <span className="ohb-permission-menu-description">
                    {mode.description}
                  </span>
                </span>
                {active ? (
                  <Check
                    aria-hidden="true"
                    className="ohb-menu-check"
                    size={14}
                  />
                ) : null}
              </button>
            );
          })}
        </Menu>
      ) : null}
      {fullAccessConfirmOpen ? (
        <FullAccessConfirmDialog
          onConfirm={confirmFullAccess}
          onDismiss={dismissFullAccessConfirm}
        />
      ) : null}
    </>
  );
}
