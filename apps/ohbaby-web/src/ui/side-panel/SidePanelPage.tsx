import type { UiBackendClient } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { SubagentReadingCache } from "../session/SubagentConversationBody.js";
import type { SidePanelTab } from "./side-pages.js";
import { SubagentsPage } from "./subagents/SubagentsPage.js";
import type { SidePanelControls } from "./use-side-panel.js";

/** What pages may need from the app; each page takes only its part. */
export interface SidePageContext {
  readonly client: UiBackendClient | null;
  /** The open primary session; absent for a new-chat draft. */
  readonly rootSessionId?: string;
  readonly subagentReadingCache: SubagentReadingCache;
  readonly setTabState: SidePanelControls["setTabState"];
}

/** Renders one tab's page. A new page kind adds its case here. */
export function SidePanelPage(props: {
  readonly tab: SidePanelTab;
  readonly context: SidePageContext;
}): ReactElement {
  const { tab, context } = props;
  switch (tab.kind) {
    // Only one page kind exists today; the next ones add their cases here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    case "subagents":
      return context.client && context.rootSessionId ? (
        <SubagentsPage
          key={context.rootSessionId}
          client={context.client}
          rootSessionId={context.rootSessionId}
          selectedSubagentId={tab.state.subagentId}
          onSelect={(subagentId) => {
            context.setTabState(tab.id, "subagents", { subagentId });
          }}
          readingCache={context.subagentReadingCache}
        />
      ) : (
        <p className="ohb-side-notice">Open a chat to see its subagents.</p>
      );
  }
}
