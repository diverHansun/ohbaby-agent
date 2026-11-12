import { ChevronRight } from "lucide-react";
import {
  type ReactElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ConnectionNotice } from "../../api/daemon/wire.js";
import { LycheeMark } from "../shared/LycheeMark.js";

/**
 * Covers the app once its services have stayed out of reach, so nothing on
 * the page looks usable when it is not. A modal dialog on the top layer, so
 * open settings, menus and other portals go inert under it too. The page
 * stays underneath, intact (drafts, scroll), and focus returns to where it
 * was when the connection does. One line of text and one link; no card.
 */
export function ConnectionOverlay(props: {
  readonly notice: ConnectionNotice;
  readonly onReconnect: () => void;
}): ReactElement {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Read before this render makes the page inert and drops its focus.
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const restarted = props.notice === "restarted";
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Engines without modal dialogs (and jsdom) still get the inert shell.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return (): void => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      // The shell leaves inert in the same commit; focus once it has.
      requestAnimationFrame(() => {
        if (returnFocus?.isConnected && !returnFocus.closest("[inert]"))
          returnFocus.focus({ preventScroll: true });
      });
    };
  }, [returnFocus]);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="ohb-connection-overlay"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // Escape cannot dismiss what only the connection can clear.
      onCancel={(event) => {
        event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.preventDefault();
      }}
    >
      <div className="ohb-connection-overlay-body">
        {/* Lychee in gray: the agent is here, just out of reach. */}
        <span className="ohb-connection-overlay-mark" aria-hidden="true">
          <LycheeMark size={40} />
        </span>
        <h1 id={titleId}>Disconnected</h1>
        <p id={bodyId}>
          {restarted
            ? "Your services restarted while this page was open. Refresh to continue."
            : "Your services aren’t responding. Your work on this page is safe, and it will reconnect as soon as they’re back."}
        </p>
        <button
          type="button"
          className="ohb-connection-overlay-action"
          // A modal dialog focuses its first control; keep that for jsdom.
          autoFocus
          onClick={() => {
            if (restarted) globalThis.location.reload();
            else props.onReconnect();
          }}
        >
          {restarted ? "Refresh" : "Reconnect now"}
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
