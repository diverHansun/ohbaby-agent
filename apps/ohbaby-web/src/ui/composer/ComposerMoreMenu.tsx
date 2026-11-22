import { Ellipsis } from "lucide-react";
import type { UiPermissionLevel } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { FullAccessConfirmDialog } from "../permissions/PermissionPolicyControl.js";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";

/**
 * Phones (< 640px) fold the permission mode into a More menu (D29, as
 * pi-web). Reasoning Effort moved into the model button (D37), so the menu
 * holds only Full access: a switch that still asks through the existing
 * "Enable full access?" dialog. CSS shows this only on phones; desktop keeps
 * its own controls.
 */
export function ComposerMoreMenu(props: {
  readonly permissionLevel: UiPermissionLevel;
  readonly permissionDisabled: boolean;
  readonly onSetPermission: (input: {
    readonly level: UiPermissionLevel;
  }) => void;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Focus returns once the confirmation is gone and the page is not inert.
  const refocus = useRef(false);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [confirming]);
  const fullAccess = props.permissionLevel === "full-access";

  const close = (restoreFocus: boolean): void => {
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <IconButton
        ref={triggerRef}
        label="More controls"
        className="ohb-composer-more"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          if (anchor) close(false);
          else setAnchor(anchorBelow(event.currentTarget));
        }}
      >
        <Ellipsis aria-hidden="true" size={17} />
      </IconButton>
      {anchor ? (
        <Menu anchor={anchor} label="More controls" onClose={close}>
          <button
            type="button"
            role="menuitem"
            aria-label={`Full access: ${fullAccess ? "on" : "off"}`}
            disabled={props.permissionDisabled}
            onClick={() => {
              if (fullAccess) {
                props.onSetPermission({ level: "default" });
                return;
              }
              // The confirmation replaces the menu; focus returns to More.
              close(false);
              setConfirming(true);
            }}
          >
            <span className="ohb-menu-item-text">Full access</span>
            <span
              aria-hidden="true"
              className={`ohb-switch${fullAccess ? " is-on" : ""}`}
            />
          </button>
        </Menu>
      ) : null}
      {confirming ? (
        <FullAccessConfirmDialog
          onConfirm={() => {
            refocus.current = true;
            setConfirming(false);
            props.onSetPermission({ level: "full-access" });
          }}
          onDismiss={() => {
            refocus.current = true;
            setConfirming(false);
          }}
        />
      ) : null}
    </>
  );
}
