import type { UiBackendClient } from "ohbaby-sdk";
import type { TerminalApi } from "../../api/daemon/terminals.js";
import type { ReactElement } from "react";
import type { SubagentReadingCache } from "../session/SubagentConversationBody.js";
import type { SidePanelTab } from "./side-pages.js";
import { SubagentsPage } from "./subagents/SubagentsPage.js";
import { TerminalPage } from "./terminal/TerminalPage.js";
import type { SubagentInstances } from "../shared/subagent-instances.js";
import type { SidePanelControls } from "./use-side-panel.js";

/** What pages may need from the app; each page takes only its part. */
export interface SidePageContext {
  readonly client: UiBackendClient | null;
  /** The open primary session; absent for a new-chat draft. */
  readonly rootSessionId?: string;
  readonly subagentReadingCache: SubagentReadingCache;
  readonly subagentInstances: SubagentInstances;
  readonly setTabState: SidePanelControls["setTabState"];
  readonly terminals: TerminalApi;
  readonly onTerminalExit: (
    tab: Extract<SidePanelTab, { kind: "terminal" }>,
    exitCode: number,
  ) => void;
  /** Re-reads the terminal list after a socket says its terminal is gone. */
  readonly onTerminalMissing: () => void;
}

/** Renders one tab's page. A new page kind adds its case here. */
export function SidePanelPage(props: {
  readonly tab: SidePanelTab;
  readonly context: SidePageContext;
}): ReactElement {
  const { tab, context } = props;
  switch (tab.kind) {
    case "subagents":
      return context.client && context.rootSessionId ? (
        <SubagentsPage
          key={context.rootSessionId}
          client={context.client}
          rootSessionId={context.rootSessionId}
          selectedSubagentId={tab.state.subagentId}
          anchor={tab.state.anchor}
          instances={context.subagentInstances}
          onSelect={(subagentId) => {
            context.setTabState(tab.id, "subagents", { subagentId });
          }}
          readingCache={context.subagentReadingCache}
        />
      ) : (
        <p className="ohb-side-notice">Open a chat to see its subagents.</p>
      );
    case "terminal":
      return (
        <TerminalPage
          api={context.terminals}
          state={tab.state}
          onExit={(exitCode) => {
            context.onTerminalExit(tab, exitCode);
          }}
          onMissing={context.onTerminalMissing}
        />
      );
  }
}
