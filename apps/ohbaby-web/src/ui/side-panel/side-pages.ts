import { Bot, type LucideIcon } from "lucide-react";

/**
 * Each page kind's own tab state. A new page (file preview, terminal, built-in
 * browser, side chat) adds one entry here, one entry in `SIDE_PAGES` and one
 * case in `SidePanelPage`; the panel, tabs and menu pick it up from there.
 */
export interface SidePageStates {
  /** The instance whose detail is open; absent shows the list. */
  readonly subagents: { readonly subagentId?: string };
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
  readonly initialState: SidePageStates[K];
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
};

export const SIDE_PAGE_KINDS = Object.keys(SIDE_PAGES) as SidePageKind[];
