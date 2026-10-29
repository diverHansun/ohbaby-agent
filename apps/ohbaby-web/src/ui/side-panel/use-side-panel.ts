import { useCallback, useEffect, useState } from "react";
import {
  clampSidePanelWidth,
  initialSidePanel,
  rememberSidePanel,
} from "./side-panel-preference.js";
import {
  SIDE_PAGES,
  type SidePageKind,
  type SidePageStates,
  type SidePanelTab,
} from "./side-pages.js";

export interface SidePanelState {
  readonly open: boolean;
  readonly width: number;
  /** Covers the main area like a maximized pane; never remembered. */
  readonly expanded: boolean;
  readonly tabs: readonly SidePanelTab[];
  readonly activeTabId?: string;
}

export interface SidePanelControls {
  readonly state: SidePanelState;
  readonly setOpen: (open: boolean) => void;
  readonly setWidth: (width: number) => void;
  readonly setExpanded: (expanded: boolean) => void;
  /**
   * Opens the page in a new tab; a kind may have several tabs (D36). `state`
   * lets an entry point open straight into a page, e.g. one subagent's detail.
   */
  readonly openPage: <K extends SidePageKind>(
    kind: K,
    state?: SidePageStates[K],
  ) => void;
  readonly selectTab: (id: string) => void;
  readonly closeTab: (id: string) => void;
  /** Replaces one tab's page state; the kind guards against a mismatched shape. */
  readonly setTabState: <K extends SidePageKind>(
    id: string,
    kind: K,
    state: SidePageStates[K],
  ) => void;
}

function createTab<K extends SidePageKind>(
  kind: K,
  state: SidePageStates[K],
): SidePanelTab {
  return { id: globalThis.crypto.randomUUID(), kind, state };
}

/**
 * Right panel state lives only in the front end (D46). Tabs stay in memory, so
 * collapsing keeps them while a reload shows the entry page again (D50). A new
 * primary session resets session-scoped pages; tabs themselves stay open.
 */
export function useSidePanel(
  rootSessionId: string | undefined,
): SidePanelControls {
  const [state, setState] = useState<SidePanelState>(() => ({
    ...initialSidePanel(),
    expanded: false,
    tabs: [],
  }));
  useEffect(() => {
    rememberSidePanel({ open: state.open, width: state.width });
  }, [state.open, state.width]);
  useEffect(() => {
    setState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        SIDE_PAGES[tab.kind].sessionScoped
          ? {
              ...tab,
              state: SIDE_PAGES[tab.kind].initialState,
            }
          : tab,
      ),
    }));
  }, [rootSessionId]);

  const setOpen = useCallback((open: boolean): void => {
    setState((current) => ({
      ...current,
      open,
      expanded: open && current.expanded,
    }));
  }, []);
  const setExpanded = useCallback((expanded: boolean): void => {
    setState((current) => ({ ...current, expanded }));
  }, []);
  const setWidth = useCallback((width: number): void => {
    setState((current) => ({ ...current, width: clampSidePanelWidth(width) }));
  }, []);
  const openPage = useCallback(
    <K extends SidePageKind>(kind: K, pageState?: SidePageStates[K]): void => {
      const tab = createTab(kind, pageState ?? SIDE_PAGES[kind].initialState);
      setState((current) => ({
        ...current,
        open: true,
        tabs: [...current.tabs, tab],
        activeTabId: tab.id,
      }));
    },
    [],
  );
  const selectTab = useCallback((id: string): void => {
    setState((current) => ({ ...current, activeTabId: id }));
  }, []);
  const closeTab = useCallback((id: string): void => {
    setState((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      const activeTabId =
        current.activeTabId === id
          ? tabs[Math.min(index, tabs.length - 1)]?.id
          : current.activeTabId;
      return { ...current, tabs, activeTabId };
    });
  }, []);
  const setTabState = useCallback(
    <K extends SidePageKind>(
      id: string,
      kind: K,
      pageState: SidePageStates[K],
    ): void => {
      setState((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- always true until a second page kind exists
          tab.id === id && tab.kind === kind
            ? { ...tab, state: pageState }
            : tab,
        ),
      }));
    },
    [],
  );
  return {
    state,
    setOpen,
    setWidth,
    setExpanded,
    openPage,
    selectTab,
    closeTab,
    setTabState,
  };
}
