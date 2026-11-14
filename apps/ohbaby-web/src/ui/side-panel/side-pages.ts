import {
  Bot,
  FolderOpen,
  MessageCircleQuestion,
  SquareTerminal,
  Timer,
  type LucideIcon,
} from "lucide-react";
import type { TerminalInfo } from "ohbaby-sdk";
import type { SideChatEntry } from "../../runtime/side-chat.js";

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
  readonly backgroundTasks: {
    /** The task whose detail is open; absent shows the list. */
    readonly jobId?: string;
  };
  readonly files: {
    /** The file whose preview is open, relative to scratch; absent shows the list. */
    readonly path?: string;
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
  readonly sideChat: {
    /** The main chat it was opened from; its tab shows only beside that chat. */
    readonly mainSessionId: string;
    /** Always a real side chat; tabs open only after the server made one. */
    readonly entry: SideChatEntry;
    /** An approval is waiting in this side chat. */
    readonly awaitingApproval?: boolean;
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

export interface SideTabLabel {
  readonly title: string;
  /** The tab's tooltip. */
  readonly detail?: string;
  /** A small dot after the title, explained by this text. */
  readonly attention?: string;
}

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
  readonly tabLabel?: (state: SidePageStates[K]) => SideTabLabel;
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
  backgroundTasks: {
    title: "Background tasks",
    description: "See and cancel this chat's background tasks",
    icon: Timer,
    initialState: {},
    sessionScoped: true,
  },
  files: {
    title: "Files",
    description: "Open files this chat saved",
    icon: FolderOpen,
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
  sideChat: {
    title: "Side chat",
    description: "Ask about this chat without changing it",
    icon: MessageCircleQuestion,
    tabLabel: ({ entry, awaitingApproval }) => ({
      title: entry.title,
      ...(awaitingApproval ? { attention: "Waiting for approval" } : {}),
    }),
    // Tabs belong to their main chat; `useSidePanel` hides the others.
    sessionScoped: false,
  },
};

/** The label of one tab: its page's own, else the page title. */
export function sideTabLabel(tab: SidePanelTab): SideTabLabel {
  switch (tab.kind) {
    case "terminal":
      return SIDE_PAGES.terminal.tabLabel?.(tab.state) ?? { title: "Terminal" };
    case "sideChat":
      return (
        SIDE_PAGES.sideChat.tabLabel?.(tab.state) ?? { title: "Side chat" }
      );
    default:
      return { title: SIDE_PAGES[tab.kind].title };
  }
}

export const SIDE_PAGE_KINDS = Object.keys(SIDE_PAGES) as SidePageKind[];
