import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { isNarrowViewport } from "../shared/viewport.js";
import {
  initialSidebarOpen,
  rememberSidebarOpen,
} from "./sidebar-preference.js";

/**
 * Two-column layout: sidebar and main area. Owns only the sidebar's open state;
 * on narrow windows the sidebar becomes a drawer over the main area.
 */
export function AppShell(props: {
  /**
   * `close` collapses the sidebar; `dismissDrawer` closes it only while it is a
   * drawer (narrow windows), for actions that move the user to the main area.
   */
  readonly renderSidebar: (
    close: () => void,
    dismissDrawer: () => void,
  ) => ReactNode;
  readonly renderHeader: (
    sidebarOpen: boolean,
    openSidebar: () => void,
  ) => ReactNode;
  readonly main: ReactNode;
  readonly overlays?: ReactNode;
}): ReactElement {
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const setOpen = useCallback((open: boolean): void => {
    setSidebarOpen(open);
    rememberSidebarOpen(open);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);
  const open = useCallback(() => {
    setOpen(true);
  }, [setOpen]);
  const dismissDrawer = useCallback(() => {
    if (isNarrowViewport()) close();
  }, [close]);
  return (
    <div className={`ohb-shell${sidebarOpen ? " is-sidebar-open" : ""}`}>
      <div className="ohb-shell-sidebar" inert={!sidebarOpen}>
        {props.renderSidebar(close, dismissDrawer)}
      </div>
      {sidebarOpen ? (
        <div
          className="ohb-shell-scrim"
          aria-hidden="true"
          onClick={dismissDrawer}
        />
      ) : null}
      <main className="ohb-shell-main">
        {props.renderHeader(sidebarOpen, open)}
        {props.main}
      </main>
      {props.overlays}
    </div>
  );
}
