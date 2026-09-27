import { X } from "lucide-react";
import type { UiBackendClient } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import type { OhbabyWebRuntime } from "../../runtime.js";
import { type ViewModel } from "../session/selectors.js";
import { CompactOverlayBody } from "./CompactOverlay.js";
import {
  ConnectModelOverlayBody,
  ConnectSearchOverlayBody,
} from "./ConnectOverlay.js";
import {
  DEFAULT_GOAL_PANEL_INTENT,
  GoalOverlayBody,
  type GoalPanelIntent,
} from "./GoalControl.js";
import { type SlashPaletteItem } from "./slashCommands.js";

type StructuredOverlayKind = "compact" | "connect" | "connect-search" | "goal";

export interface StructuredCommandRequest {
  readonly item: SlashPaletteItem;
  readonly text: string;
}

export interface StructuredOverlayState {
  readonly commandLabel: string;
  readonly goalIntent?: GoalPanelIntent;
  readonly kind: StructuredOverlayKind;
}

export function StructuredCommandOverlay(props: {
  readonly client: UiBackendClient;
  readonly onClose: () => void;
  readonly onExecuteSlashCommand: OhbabyWebRuntime["executeSlashCommand"];
  readonly overlay: StructuredOverlayState;
  readonly view: ViewModel;
}): ReactElement {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (dialogRef.current?.contains(document.activeElement)) {
      return;
    }
    closeButtonRef.current?.focus();
  }, [props.overlay.kind]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onClose]);

  return (
    <div
      className="ohb-structured-overlay"
      onClick={props.onClose}
      role="presentation"
    >
      <section
        aria-label={structuredOverlayTitle(props.overlay.kind)}
        aria-modal="true"
        className="ohb-structured-dialog"
        onClick={(event) => {
          event.stopPropagation();
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="ohb-structured-header">
          <span>{props.overlay.commandLabel}</span>
          <h2>{structuredOverlayTitle(props.overlay.kind)}</h2>
          <button
            onClick={props.onClose}
            ref={closeButtonRef}
            title="Close overlay"
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        {props.overlay.kind === "connect" ? (
          <ConnectModelOverlayBody client={props.client} />
        ) : props.overlay.kind === "connect-search" ? (
          <ConnectSearchOverlayBody client={props.client} />
        ) : props.overlay.kind === "goal" ? (
          <GoalOverlayBody
            intent={props.overlay.goalIntent ?? DEFAULT_GOAL_PANEL_INTENT}
            onExecuteSlashCommand={props.onExecuteSlashCommand}
            view={props.view}
          />
        ) : (
          <CompactOverlayBody client={props.client} view={props.view} />
        )}
      </section>
    </div>
  );
}

export function structuredOverlayKindForAction(
  action: SlashPaletteItem["action"],
): StructuredOverlayKind | null {
  switch (action) {
    case "compactSession":
      return "compact";
    case "connectModel":
      return "connect";
    case "connectSearch":
      return "connect-search";
    case "executeCommand":
      return null;
    case "openGoalPanel":
      return "goal";
  }
}

function structuredOverlayTitle(kind: StructuredOverlayKind): string {
  switch (kind) {
    case "compact":
      return "Compact context";
    case "connect":
      return "Connect model";
    case "connect-search":
      return "Connect search";
    case "goal":
      return "Goal";
  }
}
