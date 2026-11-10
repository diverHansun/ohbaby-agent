import { useCallback, useEffect, useMemo, useState } from "react";
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
  /** What the panel shows: side chats of other main chats are left out. */
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
  /**
   * Shows a page in the panel for an entry point elsewhere: reuses the
   * selected tab when it is that kind, else the first one of that kind, else
   * opens a new tab; then replaces its state.
   */
  readonly revealPage: <K extends SidePageKind>(
    kind: K,
    state: SidePageStates[K],
  ) => void;
  readonly selectTab: (id: string) => void;
  readonly closeTab: (id: string) => void;
  /** Replaces one tab's page state; the kind guards against a mismatched shape. */
  readonly setTabState: <K extends SidePageKind>(
    id: string,
    kind: K,
    state: SidePageStates[K],
  ) => void;
  /**
   * Appends tabs found elsewhere (terminals after a reload) without opening the
   * panel or changing the selected tab; selects the first only when none is.
   * With `reveal`, opens the panel on the (existing or new) tab of the first
   * state instead, so a page that already arrived is never doubled.
   */
  readonly addTabs: <K extends SidePageKind>(
    kind: K,
    states: readonly SidePageStates[K][],
    same: (left: SidePageStates[K], right: SidePageStates[K]) => boolean,
    reveal?: boolean,
  ) => void;
  /** Rewrites every tab of one kind, e.g. after a terminal list read. */
  readonly updateTabs: <K extends SidePageKind>(
    kind: K,
    update: (state: SidePageStates[K]) => SidePageStates[K],
  ) => void;
}

function createTab<K extends SidePageKind>(
  kind: K,
  state: SidePageStates[K],
): SidePanelTab {
  return { id: globalThis.crypto.randomUUID(), kind, state } as SidePanelTab;
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
      tabs: current.tabs.map((tab) => {
        const { sessionScoped, initialState } = SIDE_PAGES[tab.kind];
        return sessionScoped && initialState !== undefined
          ? ({ ...tab, state: initialState } as SidePanelTab)
          : tab;
      }),
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
      const initial = pageState ?? SIDE_PAGES[kind].initialState;
      if (initial === undefined) return;
      const tab = createTab(kind, initial);
      setState((current) => ({
        ...current,
        open: true,
        tabs: [...current.tabs, tab],
        activeTabId: tab.id,
      }));
    },
    [],
  );
  const revealPage = useCallback(
    <K extends SidePageKind>(kind: K, pageState: SidePageStates[K]): void => {
      setState((current) => {
        const active = current.tabs.find(
          (tab) => tab.id === current.activeTabId,
        );
        const target =
          active?.kind === kind
            ? active
            : current.tabs.find((tab) => tab.kind === kind);
        if (!target) {
          const tab = createTab(kind, pageState);
          return {
            ...current,
            open: true,
            tabs: [...current.tabs, tab],
            activeTabId: tab.id,
          };
        }
        return {
          ...current,
          open: true,
          activeTabId: target.id,
          tabs: current.tabs.map((tab) =>
            tab.id === target.id
              ? ({ ...tab, state: pageState } as SidePanelTab)
              : tab,
          ),
        };
      });
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
          tab.id === id && tab.kind === kind
            ? ({ ...tab, state: pageState } as SidePanelTab)
            : tab,
        ),
      }));
    },
    [],
  );
  const addTabs = useCallback(
    <K extends SidePageKind>(
      kind: K,
      states: readonly SidePageStates[K][],
      same: (left: SidePageStates[K], right: SidePageStates[K]) => boolean,
      reveal = false,
    ): void => {
      setState((current) => {
        const find = (state: SidePageStates[K]): SidePanelTab | undefined =>
          current.tabs.find(
            (tab) =>
              tab.kind === kind && same(tab.state as SidePageStates[K], state),
          );
        const added = states
          .filter((state) => !find(state))
          .map((state) => createTab(kind, state));
        const tabs = [...current.tabs, ...added];
        if (reveal && states.length > 0) {
          const target = find(states[0]) ?? added[0];
          return { ...current, open: true, tabs, activeTabId: target.id };
        }
        if (added.length === 0) return current;
        return {
          ...current,
          tabs,
          activeTabId: current.activeTabId ?? added[0]?.id,
        };
      });
    },
    [],
  );
  const updateTabs = useCallback(
    <K extends SidePageKind>(
      kind: K,
      update: (state: SidePageStates[K]) => SidePageStates[K],
    ): void => {
      setState((current) => {
        const tabs = current.tabs.map((tab) => {
          if (tab.kind !== kind) return tab;
          const state = update(tab.state as SidePageStates[K]);
          return state === tab.state
            ? tab
            : ({ ...tab, state } as SidePanelTab);
        });
        // Unchanged tabs keep their identity, so nothing re-renders for nothing.
        return tabs.some((tab, index) => tab !== current.tabs[index])
          ? { ...current, tabs }
          : current;
      });
    },
    [],
  );
  // A side chat tab shows only beside its main chat. The others stay open
  // (their clients too) and come back when that chat is opened again.
  const visible = useMemo((): SidePanelState => {
    const tabs = state.tabs.filter(
      (tab) =>
        tab.kind !== "sideChat" || tab.state.mainSessionId === rootSessionId,
    );
    if (tabs.length === state.tabs.length) return state;
    const activeTabId = tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : tabs.at(-1)?.id;
    return { ...state, tabs, activeTabId };
  }, [state, rootSessionId]);
  return {
    state: visible,
    setOpen,
    setWidth,
    setExpanded,
    openPage,
    revealPage,
    selectTab,
    closeTab,
    setTabState,
    addTabs,
    updateTabs,
  };
}
