import { ArrowLeft, X } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { focusableIn, trapTab } from "../shared/focus-trap.js";
import { IconButton } from "../shared/IconButton.js";
import { isPhoneViewport } from "../shared/viewport.js";
import { ModelsSection } from "./ModelsSection.js";
import { SearchSection } from "./SearchSection.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "./sections.js";
import { SettingsNav } from "./SettingsNav.js";
import type { SettingsDialogState } from "./useSettingsDialog.js";

/**
 * The settings dialog (D2, 03 §4.7): section navigation on the left, the
 * section on the right, × at the top. It is modal (focus moves in, Tab stays
 * inside, the page behind is inert) and closes with × or Escape, never with a
 * click on the scrim. Closing hides it so an unsaved edit survives until the
 * user switches section or reloads. Nothing about it is written to the URL.
 */
export function SettingsDialog(props: {
  readonly settings: SettingsLayer;
  readonly state: SettingsDialogState;
  readonly onClose: () => void;
  readonly onSelectSection: (section: SettingsSection) => void;
  readonly onShowNav: () => void;
}): ReactElement {
  const { state } = props;
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  returnFocus.current = state.returnFocus;

  useLayoutEffect(() => {
    if (!state.open) return;
    const shell = document.querySelector(".ohb-shell");
    const wasInert = shell?.hasAttribute("inert") ?? false;
    shell?.setAttribute("inert", "");
    const dialog = dialogRef.current;
    if (dialog) {
      // Desktop: the current section in the nav. A phone showing one
      // section: its first control, else Close.
      const current = dialog.querySelector<HTMLElement>(
        ".ohb-settings-nav [aria-current='page']",
      );
      const target =
        current && (!isPhoneViewport() || state.pane === "nav")
          ? current
          : (focusableIn(dialog).find(
              (element) => element.closest(".ohb-settings-content") !== null,
            ) ?? dialog.querySelector<HTMLElement>(".ohb-settings-close"));
      target?.focus({ preventScroll: true });
    }
    return (): void => {
      if (!wasInert) shell?.removeAttribute("inert");
    };
  }, [state.open]);

  // Focus goes back after the commit: the dialog only hides, and React
  // restores the focus it saw before a commit once mutations are done.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (state.open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const previous = returnFocus.current;
    // The trigger may sit in a collapsed (inert) sidebar by now.
    if (previous?.isConnected && !previous.closest("[inert]"))
      previous.focus({ preventScroll: true });
  }, [state.open]);

  const label =
    SETTINGS_SECTIONS.find((section) => section.id === state.section)?.label ??
    "Settings";

  return createPortal(
    <div className="ohb-settings-layer" hidden={!state.open}>
      <div className="ohb-settings-scrim" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="ohb-settings-dialog"
        data-pane={state.pane}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
            return;
          }
          trapTab(event, dialogRef.current);
        }}
      >
        <header className="ohb-settings-header">
          <IconButton
            label="All settings"
            className="ohb-settings-back"
            onClick={props.onShowNav}
          >
            <ArrowLeft aria-hidden="true" size={16} />
          </IconButton>
          <h1 id={titleId}>
            <span className="ohb-settings-title-root">Settings</span>
            <span className="ohb-settings-title-section">{label}</span>
          </h1>
          <IconButton
            label="Close settings"
            className="ohb-settings-close"
            onClick={props.onClose}
          >
            <X aria-hidden="true" size={16} />
          </IconButton>
        </header>
        <div className="ohb-settings-body">
          <SettingsNav
            current={state.section}
            onSelect={props.onSelectSection}
          />
          <div className="ohb-settings-content" key={state.resetKey}>
            {state.section === "models" ? (
              <ModelsSection settings={props.settings} visible={state.open} />
            ) : (
              <SearchSection settings={props.settings} visible={state.open} />
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
