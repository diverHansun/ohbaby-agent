import type { UiBackendClient } from "ohbaby-sdk";
import type { SessionFilesApi } from "../../api/daemon/session-files.js";
import type { TerminalApi } from "../../api/daemon/terminals.js";
import type { ReactElement } from "react";
import type { SubagentReadingCache } from "../session/SubagentConversationBody.js";
import type { SidePanelTab } from "./side-pages.js";
import { FilesPage } from "./files/FilesPage.js";
import { SubagentsPage } from "./subagents/SubagentsPage.js";
import { TerminalPage } from "./terminal/TerminalPage.js";
import type { SideChatConnection } from "../../runtime/side-chat.js";
import { SideChatPage } from "../side-chat/SideChatPage.js";
import type { SubagentInstances } from "../shared/subagent-instances.js";
import {
  BackgroundTaskOpener,
  type BackgroundTaskProbe,
} from "../shared/background-tasks.js";
import { BackgroundTasksPage } from "./background-tasks/BackgroundTasksPage.js";
import type { SidePanelControls } from "./use-side-panel.js";

/** What pages may need from the app; each page takes only its part. */
export interface SidePageContext {
  readonly client: UiBackendClient | null;
  /** The open primary session; absent for a new-chat draft. */
  readonly rootSessionId?: string;
  readonly subagentReadingCache: SubagentReadingCache;
  readonly subagentInstances: SubagentInstances;
  /** Whether and where the open chat has background tasks. */
  readonly backgroundTaskProbe: BackgroundTaskProbe;
  readonly setTabState: SidePanelControls["setTabState"];
  readonly sessionFiles: SessionFilesApi;
  readonly terminals: TerminalApi;
  readonly onTerminalExit: (
    tab: Extract<SidePanelTab, { kind: "terminal" }>,
    exitCode: number,
  ) => void;
  /** Re-reads the terminal list after a socket says its terminal is gone. */
  readonly onTerminalMissing: () => void;
  /** The side chat's own client; absent only until it is created. */
  readonly sideChat: (sideChatId: string) => SideChatConnection | undefined;
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
    case "backgroundTasks":
      return context.client && context.rootSessionId ? (
        <BackgroundTasksPage
          key={context.rootSessionId}
          client={context.client}
          rootSessionId={context.rootSessionId}
          selectedJobId={tab.state.jobId}
          probe={context.backgroundTaskProbe}
          onSelect={(jobId) => {
            context.setTabState(
              tab.id,
              "backgroundTasks",
              jobId === undefined ? {} : { jobId },
            );
          }}
        />
      ) : (
        <p className="ohb-side-notice">
          Open a chat to see its background tasks.
        </p>
      );
    case "files":
      return context.client && context.rootSessionId ? (
        <FilesPage
          key={context.rootSessionId}
          api={context.sessionFiles}
          client={context.client}
          rootSessionId={context.rootSessionId}
          selectedPath={tab.state.path}
          onSelect={(path) => {
            context.setTabState(
              tab.id,
              "files",
              path === undefined ? {} : { path },
            );
          }}
        />
      ) : (
        <p className="ohb-side-notice">Open a chat to see its files.</p>
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
    case "sideChat": {
      const connection = context.sideChat(tab.state.entry.sideChatId);
      return connection ? (
        <BackgroundTaskOpener.Provider value={undefined}>
          <SideChatPage connection={connection} entry={tab.state.entry} />
        </BackgroundTaskOpener.Provider>
      ) : (
        <p className="ohb-side-notice" role="status">
          Connecting…
        </p>
      );
    }
  }
}
