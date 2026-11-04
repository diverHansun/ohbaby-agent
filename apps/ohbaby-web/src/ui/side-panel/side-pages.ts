import { Bot, SquareTerminal, type LucideIcon } from "lucide-react";
import type { TerminalInfo } from "ohbaby-sdk";

/**
 * Each page kind's own tab state. A new page (file preview, terminal, built-in
 * browser, side chat) adds one entry here, one entry in `SIDE_PAGES` and one
 * case in `SidePanelPage`; the panel, tabs and menu pick it up from there.
 */
export interface SidePageStates {
  readonly subagents: {
    /** The instance whose detail is open; absent shows the list. */
    readonly subagentId?: string;
    /** Set only by an explicit "show this delegation" request. */
    readonly anchor?: SubagentAnchor;
  };
  readonly terminal: {
    /** Always a real server terminal; tabs open only after it exists (D1). */
    readonly terminal: TerminalInfo;
    /** The server no longer lists it; an exit the page saw still wins (D9). */
    readonly gone?: boolean;
    /** This page is waiting for its close request (D7). */
    readonly closing?: boolean;
    /** The shell exited while shown; the tab keeps saying so after it is gone. */
    readonly exitCode?: number;
  };
}

/** One delegation to scroll to; a new `token` repeats the request. */
export interface SubagentAnchor {
  readonly executionId: string;
  readonly token: number;
}

export type SidePageKind = keyof SidePageStates;

/** One open tab; `state` is typed by its page kind. */
export type SidePanelTab = {
  readonly [K in SidePageKind]: {
    readonly id: string;
    readonly kind: K;
    readonly state: SidePageStates[K];
  };
}[SidePageKind];

export interface SidePageDefinition<K extends SidePageKind> {
  readonly title: string;
  /** One line for the entry page. */
  readonly description: string;
  readonly icon: LucideIcon;
  /**
   * The state a generic "open" starts from. Absent for terminals, whose tabs
   * open only with a real terminal from the server.
   */
  readonly initialState?: SidePageStates[K];
  /** A per-tab label; without it the tab shows `title`. */
  readonly tabLabel?: (state: SidePageStates[K]) => {
    readonly title: string;
    readonly detail?: string;
  };
  /**
   * Pages about the open chat (Subagents) return to `initialState` when the
   * primary session changes; pages about the workspace or the web (terminal,
   * browser, file preview) keep theirs.
   */
  readonly sessionScoped: boolean;
}

/** Only pages that work today are listed (D36, D38); no placeholders. */
export const SIDE_PAGES: {
  readonly [K in SidePageKind]: SidePageDefinition<K>;
} = {
  subagents: {
    title: "Subagents",
    description: "Read and stop this chat's subagents",
    icon: Bot,
    initialState: {},
    sessionScoped: true,
  },
  terminal: {
    title: "Terminal",
    description: "Run commands in this workspace",
    icon: SquareTerminal,
    tabLabel: ({ terminal }) => ({
      title: terminal.title,
      detail: `${terminal.directory} · ${terminal.shell}`,
    }),
    sessionScoped: false,
  },
};

export const SIDE_PAGE_KINDS = Object.keys(SIDE_PAGES) as SidePageKind[];
