import { Maximize2, Minimize2, PanelRight, Plus, X } from "lucide-react";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import { isNarrowViewport } from "../shared/viewport.js";
import {
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
} from "./side-panel-preference.js";
import {
  SIDE_PAGE_KINDS,
  SIDE_PAGES,
  sideTabLabel,
  type SidePageKind,
  type SidePanelTab,
} from "./side-pages.js";
import type { SidePanelControls } from "./use-side-panel.js";
import { useTabDrag } from "./use-tab-drag.js";

const KEYBOARD_STEP = 24;

/**
 * The right panel (03 §4.9): tabs, an add-page menu, a resize handle, an
 * expand toggle and the entry page. It is rendered only while open, so
 * collapsing it unmounts the pages and releases their reads; tab state stays
 * with the caller.
 */
export function SidePanel(props: {
  readonly controls: SidePanelControls;
  readonly renderPage: (tab: SidePanelTab) => ReactNode;
  /** Called after the panel closes itself, so the caller can move focus back. */
  readonly onClosed?: () => void;
  /**
   * The user opened the panel, so focus moves into it; otherwise Escape below
   * 1024px would reach nothing. A panel restored on reload leaves focus alone.
   */
  readonly focusOnOpen?: boolean;
  /** Terminals open only once the server created one (D1). */
  readonly onNewTerminal?: () => void;
  /** Terminal tabs close through the server and may ask first (D7). */
  readonly onCloseTerminal?: (
    tab: Extract<SidePanelTab, { kind: "terminal" }>,
    remove: (id: string) => void,
  ) => void;
  /** Side chats open only once the server made one. */
  readonly onNewSideChat?: () => void;
  /** Why a side chat cannot be opened now; its entries are dimmed. */
  readonly sideChatUnavailable?: string;
  /** Closing a side chat deletes it; the tab leaves at once. */
  readonly onCloseSideChat?: (
    tab: Extract<SidePanelTab, { kind: "sideChat" }>,
    remove: (id: string) => void,
  ) => void;
}): ReactElement {
  const {
    state,
    setOpen,
    setWidth,
    setExpanded,
    openPage,
    selectTab,
    moveTab,
    closeTab,
  } = props.controls;
  const [addMenu, setAddMenu] = useState<MenuAnchor | null>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const tabDrag = useTabDrag({
    list: tabList,
    select: selectTab,
    move: moveTab,
  });
  const addButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{
    startX: number;
    startWidth: number;
    maxWidth: number;
  } | null>(null);
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  const kinds = SIDE_PAGE_KINDS.filter(
    (kind) => !props.controls.hiddenKinds.includes(kind),
  );
  const panel = useRef<HTMLElement>(null);
  const resizeBounds = (): { width: number; maxWidth: number } => {
    // CSS can show less than the stored width to preserve room for the chat.
    // Both keyboard and pointer resizing start from what is on screen.
    const shown = panel.current?.getBoundingClientRect().width;
    const width = shown !== undefined && shown > 0 ? shown : state.width;
    const main = panel.current
      ?.closest(".ohb-shell")
      ?.querySelector(".ohb-shell-main");
    const mainMin = main
      ? Number.parseFloat(
          getComputedStyle(main).getPropertyValue("--main-min-width"),
        )
      : Number.NaN;
    return {
      width,
      maxWidth:
        main && Number.isFinite(mainMin)
          ? width + main.getBoundingClientRect().width - mainMin
          : Number.POSITIVE_INFINITY,
    };
  };
  const focusTab = (id: string): void => {
    requestAnimationFrame(() => {
      document.getElementById(`ohb-side-tab-${id}`)?.focus();
    });
  };
  const closeTabAndFocus = (id: string): void => {
    closeTab(id);
    // Focus follows the tab that takes its place, or the entry page.
    requestAnimationFrame(() => {
      panel.current
        ?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"], .ohb-side-panel-entry button',
        )
        ?.focus();
    });
  };
  const requestClose = (tab: SidePanelTab): void => {
    if (tab.kind === "terminal" && props.onCloseTerminal)
      props.onCloseTerminal(tab, closeTabAndFocus);
    else if (tab.kind === "sideChat" && props.onCloseSideChat)
      props.onCloseSideChat(tab, closeTabAndFocus);
    else closeTabAndFocus(tab.id);
  };
  const open = (kind: SidePageKind): void => {
    if (kind === "terminal") props.onNewTerminal?.();
    else if (kind === "sideChat") props.onNewSideChat?.();
    else openPage(kind);
  };
  const unavailable = (kind: SidePageKind): string | undefined =>
    kind === "sideChat" ? props.sideChatUnavailable : undefined;
  const closePanel = (): void => {
    setOpen(false);
    props.onClosed?.();
  };
  const focusOnOpen = props.focusOnOpen === true;
  useLayoutEffect(() => {
    const element = panel.current;
    // A page that already took focus (a detail heading) keeps it.
    if (!focusOnOpen || !element || element.contains(document.activeElement))
      return;
    element
      .querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"], .ohb-side-panel-entry button',
      )
      ?.focus({ preventScroll: true });
  }, [focusOnOpen]);

  return (
    <aside
      ref={panel}
      className="ohb-side-panel"
      aria-label="Side panel"
      onKeyDown={(event) => {
        // Where the panel covers the chat, Escape is the way back (03 §5).
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (isNarrowViewport()) {
          event.preventDefault();
          closePanel();
        } else if (state.expanded) {
          event.preventDefault();
          setExpanded(false);
        }
      }}
      style={
        {
          "--side-panel-width": `${String(state.width)}px`,
          "--side-panel-min-width": `${String(SIDE_PANEL_MIN_WIDTH)}px`,
        } as CSSProperties
      }
    >
      <div
        className="ohb-side-panel-resize"
        role="separator"
        aria-label="Resize side panel"
        aria-orientation="vertical"
        aria-valuemin={SIDE_PANEL_MIN_WIDTH}
        aria-valuemax={SIDE_PANEL_MAX_WIDTH}
        aria-valuenow={state.width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const { width, maxWidth } = resizeBounds();
          const step =
            event.key === "ArrowLeft" ? KEYBOARD_STEP : -KEYBOARD_STEP;
          setWidth(Math.min(maxWidth, width + step));
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const { width, maxWidth } = resizeBounds();
          drag.current = {
            startX: event.clientX,
            startWidth: width,
            maxWidth,
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const { startX, startWidth, maxWidth } = drag.current;
          setWidth(Math.min(maxWidth, startWidth + startX - event.clientX));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      <header className="ohb-side-panel-header">
        <div
          ref={tabList}
          className="ohb-side-panel-tabs"
          role="tablist"
          aria-label="Side panel pages"
          onKeyDown={(event) => {
            const index = state.tabs.findIndex(
              (tab) => tab.id === state.activeTabId,
            );
            const current = state.tabs.at(index);
            if (index < 0 || !current) return;
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              requestClose(current);
              return;
            }
            const step =
              event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0;
            if (step === 0) return;
            event.preventDefault();
            const next = state.tabs.at(
              (index + step + state.tabs.length) % state.tabs.length,
            );
            if (next) {
              selectTab(next.id);
              focusTab(next.id);
            }
          }}
        >
          {state.tabs.map((tab) => {
            const { icon: Icon } = SIDE_PAGES[tab.kind];
            const label = sideTabLabel(tab);
            const closing = tab.kind === "terminal" && tab.state.closing;
            const selected = tab.id === state.activeTabId;
            const dragging = tab.id === tabDrag.draggingId;
            return (
              <div
                key={tab.id}
                role="presentation"
                data-side-tab={tab.id}
                className={`ohb-side-panel-tab${selected ? " is-active" : ""}${dragging ? " is-dragging" : ""}`}
                onPointerDown={(event) => {
                  tabDrag.onPointerDown(tab.id, event);
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={
                    selected ? `ohb-side-page-${tab.id}` : undefined
                  }
                  id={`ohb-side-tab-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  title={label.detail}
                  onClick={() => {
                    selectTab(tab.id);
                  }}
                >
                  <Icon aria-hidden="true" size={14} />
                  <span>{label.title}</span>
                  {label.attention ? (
                    <span
                      className="ohb-side-panel-tab-attention"
                      role="img"
                      aria-label={label.attention}
                      title={label.attention}
                    />
                  ) : null}
                </button>
                {/* Mouse shortcut only; keyboard users close the selected tab with Delete. */}
                <button
                  type="button"
                  className="ohb-side-panel-tab-close"
                  aria-hidden="true"
                  tabIndex={-1}
                  title={`Close ${label.title}`}
                  disabled={closing}
                  // A press on close never starts a drag of its tab.
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={() => {
                    requestClose(tab);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton
          ref={addButton}
          label="Add page"
          aria-haspopup="menu"
          aria-expanded={addMenu !== null}
          onClick={(event) => {
            setAddMenu(anchorBelow(event.currentTarget));
          }}
        >
          <Plus aria-hidden="true" size={15} />
        </IconButton>
        <span className="ohb-side-panel-actions">
          <IconButton
            className="ohb-side-panel-expand"
            label={state.expanded ? "Restore side panel" : "Expand side panel"}
            aria-pressed={state.expanded}
            onClick={() => {
              setExpanded(!state.expanded);
            }}
          >
            {state.expanded ? (
              <Minimize2 aria-hidden="true" size={14} />
            ) : (
              <Maximize2 aria-hidden="true" size={14} />
            )}
          </IconButton>
          <button
            type="button"
            className="ohb-side-panel-close"
            aria-label="Close side panel"
            title="Close side panel"
            onClick={closePanel}
          >
            {/* Below 1024px the panel covers the chat, so the way back is spelled out (03 §5). */}
            <span className="ohb-side-panel-close-text">Back to chat</span>
            <PanelRight aria-hidden="true" size={15} />
          </button>
        </span>
      </header>
      {active ? (
        <div
          className="ohb-side-panel-page"
          role="tabpanel"
          id={`ohb-side-page-${active.id}`}
          aria-labelledby={`ohb-side-tab-${active.id}`}
        >
          {props.renderPage(active)}
        </div>
      ) : (
        <div className="ohb-side-panel-entry">
          <h2>Open a page</h2>
          {kinds.map((kind) => {
            const { title, description, icon: Icon } = SIDE_PAGES[kind];
            return (
              <button
                key={kind}
                type="button"
                disabled={unavailable(kind) !== undefined}
                title={unavailable(kind)}
                onClick={() => {
                  open(kind);
                }}
              >
                <span className="ohb-side-panel-entry-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <span className="ohb-side-panel-entry-copy">
                  <span className="ohb-side-panel-entry-title">{title}</span>
                  <span className="ohb-side-panel-entry-text">
                    {description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {addMenu ? (
        <Menu
          anchor={addMenu}
          label="Add page"
          onClose={(restoreFocus) => {
            setAddMenu(null);
            if (restoreFocus) addButton.current?.focus();
          }}
        >
          {kinds.map((kind) => {
            const { title, icon: Icon } = SIDE_PAGES[kind];
            return (
              <button
                key={kind}
                role="menuitem"
                type="button"
                disabled={unavailable(kind) !== undefined}
                title={unavailable(kind)}
                onClick={() => {
                  setAddMenu(null);
                  open(kind);
                }}
              >
                <Icon aria-hidden="true" size={14} />
                <span>{title}</span>
              </button>
            );
          })}
        </Menu>
      ) : null}
    </aside>
  );
}
