import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { isNarrowViewport, useNarrowViewport } from "../shared/viewport.js";
import {
  initialSidebarOpen,
  rememberSidebarOpen,
} from "./sidebar-preference.js";

/**
 * Sidebar, main area and the optional right panel. Owns only the sidebar's open
 * state; on narrow windows the sidebar becomes a drawer over the main area and
 * the right panel covers the main area (03 §4.9).
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
  /** The right panel; undefined while it is closed. */
  readonly aside?: ReactNode;
  /** The right panel covers the main area, like a maximized pane. */
  readonly asideExpanded?: boolean;
  readonly overlays?: ReactNode;
  readonly onSearch?: () => void;
}): ReactElement {
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const narrow = useNarrowViewport();
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
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k" ||
        event.altKey ||
        event.repeat
      )
        return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      open();
      props.onSearch?.();
    };
    document.addEventListener("keydown", shortcut);
    return (): void => {
      document.removeEventListener("keydown", shortcut);
    };
  }, [open, props.onSearch]);
  return (
    <div
      className={`ohb-shell${sidebarOpen ? " is-sidebar-open" : ""}${props.aside !== undefined && props.asideExpanded ? " is-aside-expanded" : ""}`}
    >
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
      {/* Below 1024px or when expanded the right panel covers the chat; keep focus out of what is hidden. */}
      <main
        className="ohb-shell-main"
        inert={
          props.aside !== undefined && (narrow || props.asideExpanded === true)
        }
      >
        {props.renderHeader(sidebarOpen, open)}
        {props.main}
      </main>
      {props.aside}
      {props.overlays}
    </div>
  );
}
