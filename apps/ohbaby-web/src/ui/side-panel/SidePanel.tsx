import { Maximize2, Minimize2, PanelRight, Plus, X } from "lucide-react";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
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
  type SidePanelTab,
} from "./side-pages.js";
import type { SidePanelControls } from "./use-side-panel.js";

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
}): ReactElement {
  const {
    state,
    setOpen,
    setWidth,
    setExpanded,
    openPage,
    selectTab,
    closeTab,
  } = props.controls;
  const [addMenu, setAddMenu] = useState<MenuAnchor | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  const panel = useRef<HTMLElement>(null);
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
  const closePanel = (): void => {
    setOpen(false);
    props.onClosed?.();
  };

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
        { "--side-panel-width": `${String(state.width)}px` } as CSSProperties
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
          if (event.key === "ArrowLeft") setWidth(state.width + KEYBOARD_STEP);
          else if (event.key === "ArrowRight")
            setWidth(state.width - KEYBOARD_STEP);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startWidth: state.width };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setWidth(
            drag.current.startWidth + drag.current.startX - event.clientX,
          );
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
              closeTabAndFocus(current.id);
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
            const { title, icon: Icon } = SIDE_PAGES[tab.kind];
            const selected = tab.id === state.activeTabId;
            return (
              <div
                key={tab.id}
                role="presentation"
                className={`ohb-side-panel-tab${selected ? " is-active" : ""}`}
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
                  onClick={() => {
                    selectTab(tab.id);
                  }}
                >
                  <Icon aria-hidden="true" size={14} />
                  <span>{title}</span>
                </button>
                {/* Mouse shortcut only; keyboard users close the selected tab with Delete. */}
                <button
                  type="button"
                  className="ohb-side-panel-tab-close"
                  aria-hidden="true"
                  tabIndex={-1}
                  title={`Close ${title}`}
                  onClick={() => {
                    closeTabAndFocus(tab.id);
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
          {SIDE_PAGE_KINDS.map((kind) => {
            const { title, description, icon: Icon } = SIDE_PAGES[kind];
            return (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  openPage(kind);
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
          {SIDE_PAGE_KINDS.map((kind) => {
            const { title, icon: Icon } = SIDE_PAGES[kind];
            return (
              <button
                key={kind}
                role="menuitem"
                type="button"
                onClick={() => {
                  setAddMenu(null);
                  openPage(kind);
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
