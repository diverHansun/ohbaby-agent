import { Check, ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import type { UiPermissionLevel } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { FullAccessConfirmDialog } from "../permissions/PermissionPolicyControl.js";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import type { ReasoningState } from "./useReasoning.js";

/**
 * Phones (< 640px) fold thinking effort and the permission mode into one
 * More menu (D29, as pi-web). Thinking opens its options in place and returns
 * to the first level after a choice; Full access is a switch that still asks
 * through the existing "Enable full access?" dialog. CSS shows this only on
 * phones; desktop keeps its own controls.
 */
export function ComposerMoreMenu(props: {
  readonly reasoning: ReasoningState;
  readonly permissionLevel: UiPermissionLevel;
  readonly permissionDisabled: boolean;
  readonly onSetPermission: (input: {
    readonly level: UiPermissionLevel;
  }) => void;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [level, setLevel] = useState<"main" | "thinking">("main");
  const [confirming, setConfirming] = useState(false);
  // Focus returns once the confirmation is gone and the page is not inert.
  const refocus = useRef(false);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [confirming]);
  const { reasoning } = props;
  const fullAccess = props.permissionLevel === "full-access";

  const close = (restoreFocus: boolean): void => {
    setAnchor(null);
    setLevel("main");
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const thinkingLabel =
    reasoning.kind === "choice"
      ? (reasoning.options.find((option) => option.value === reasoning.value)
          ?.label ?? reasoning.value)
      : reasoning.kind === "detecting"
        ? "detecting…"
        : "unknown";

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
      {anchor && level === "thinking" && reasoning.kind === "choice" ? (
        <Menu
          anchor={anchor}
          label="Thinking"
          level="thinking"
          focusSelector="[aria-current='true']"
          onClose={close}
          onEscape={() => {
            setLevel("main");
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="ohb-menu-back"
            onClick={() => {
              setLevel("main");
            }}
          >
            <ChevronLeft aria-hidden="true" size={13} />
            <span>Thinking</span>
          </button>
          {reasoning.options.map((option) => {
            const current = option.value === reasoning.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  reasoning.select(option.value);
                  setLevel("main");
                }}
              >
                <span className="ohb-menu-item-text">{option.label}</span>
                {current ? (
                  <Check
                    aria-hidden="true"
                    size={14}
                    className="ohb-menu-check"
                  />
                ) : null}
              </button>
            );
          })}
        </Menu>
      ) : anchor ? (
        <Menu
          anchor={anchor}
          label="More controls"
          level="main"
          onClose={close}
        >
          {reasoning.kind !== "hidden" ? (
            <button
              type="button"
              role="menuitem"
              disabled={reasoning.kind !== "choice"}
              onClick={() => {
                setLevel("thinking");
              }}
            >
              <span className="ohb-menu-item-text">
                Thinking: {thinkingLabel}
              </span>
              <ChevronRight
                aria-hidden="true"
                size={14}
                className="ohb-menu-arrow"
              />
            </button>
          ) : null}
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
