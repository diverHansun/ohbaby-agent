import { sessionActionErrorText } from "ohbaby-sdk";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { WorkspacePicker } from "../composer/WorkspacePicker.js";
import { DraftFallback } from "../session/DraftFallback.js";
import { selectViewModel } from "../session/selectors.js";
import { SessionScreen } from "../session/SessionScreen.js";
import { downloadTextFile } from "../shared/download-file.js";
import { type NoticeItem, NoticeStack } from "../shared/Notice.js";
import type { SubagentReadingCache } from "../session/SubagentConversationBody.js";
import { useSubagentInstances } from "../shared/subagent-instances.js";
import { SidePanel } from "../side-panel/SidePanel.js";
import {
  type SidePageContext,
  SidePanelPage,
} from "../side-panel/SidePanelPage.js";
import { useSidePanel } from "../side-panel/use-side-panel.js";
import { useSideChats } from "../side-chat/use-side-chats.js";
import { useTerminalTabs } from "../side-panel/terminal/use-terminal-tabs.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { Sidebar } from "../sidebar/Sidebar.js";
import type {
  SessionActivity,
  SidebarSessionItem,
} from "../../store/sidebar-groups.js";
import type { SessionExportFormat } from "../sidebar/SessionMenu.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import { useSettingsDialog } from "../settings/useSettingsDialog.js";
import { DirectoryPickerDialog } from "../workspace/directory-picker/DirectoryPickerDialog.js";
import { AppShell } from "./AppShell.js";
import { MainHeader } from "./MainHeader.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connects the runtime to the shell: sidebar, header, main area and the folder
 * picker. Workspace and session-list actions live here; the conversation itself
 * stays in `SessionScreen`. Failures surface as top-right notices.
 */
export function AppController(props: {
  readonly runtime: OhbabyWebRuntime;
}): ReactElement {
  const { runtime } = props;
  // Workspace changes can replace runtime.client; keep the shell subscribed.
  useSyncExternalStore(
    (listener) => runtime.subscribeWorkspaces(listener),
    () => runtime.getWorkspaceSnapshot(),
    () => runtime.getWorkspaceSnapshot(),
  );
  const storeSnapshot = useSyncExternalStore(
    (listener) => runtime.store.subscribe(listener),
    () => runtime.store.getSnapshot(),
    () => runtime.store.getSnapshot(),
  );
  const view = useMemo(() => selectViewModel(storeSnapshot), [storeSnapshot]);
  const client = runtime.client;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchFocusRequest((request) => request + 1);
  }, []);
  const searchSessions = useCallback<OhbabyWebRuntime["searchSessions"]>(
    (input) => runtime.searchSessions(input),
    [runtime],
  );
  const [notices, setNotices] = useState<readonly NoticeItem[]>([]);
  const settingsDialog = useSettingsDialog(runtime.settings);
  const { open: openSettings } = settingsDialog;
  const openModelSettings = useCallback(
    (fromDraft: boolean): void => {
      openSettings({ section: "models", fromDraft });
    },
    [openSettings],
  );
  // Where the folder picker was opened: from the draft it also selects the
  // new workspace; from the sidebar it only registers it (06 §1.1).
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState<
    "draft" | "sidebar" | null
  >(null);
  const [workspaceActionCount, setWorkspaceActionCount] = useState(0);
  const catalog = useSyncExternalStore(
    (listener) => runtime.catalog.subscribe(listener),
    () => runtime.catalog.getSnapshot(),
    () => runtime.catalog.getSnapshot(),
  );
  const draft = useSyncExternalStore(
    (listener) => runtime.draft.subscribe(listener),
    () => runtime.draft.getSnapshot(),
    () => runtime.draft.getSnapshot(),
  );

  const pushError = useCallback((error: unknown): void => {
    setNotices((current) => [
      ...current,
      {
        id: globalThis.crypto.randomUUID(),
        kind: "error",
        message: message(error),
      },
    ]);
  }, []);
  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        pushError(error);
        return false;
      }
    },
    [pushError],
  );
  const runWorkspaceAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setWorkspaceActionCount((count) => count + 1);
      try {
        return await runAction(action);
      } finally {
        setWorkspaceActionCount((count) => count - 1);
      }
    },
    [runAction],
  );

  useEffect(() => {
    void runtime.refreshCatalog().catch(pushError);
  }, [runtime, pushError]);

  const exportSession = useCallback(
    (session: SidebarSessionItem, format: SessionExportFormat): void => {
      void runAction(async () => {
        try {
          downloadTextFile(
            await runtime.exportSession(
              session.id,
              format,
              session.requestDirectory,
            ),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            "status" in error &&
            error.status === 404 &&
            (!("code" in error) || error.code === undefined)
          ) {
            throw new Error("Export is not supported by this backend.", {
              cause: error,
            });
          }
          throw error;
        }
      });
    },
    [runAction, runtime],
  );

  // Fork switches to the new chat; a refusal says why in a notice (design §4.1).
  const forkSession = useCallback(
    (
      sessionId: string,
      options?: { readonly runId?: string; readonly directory?: string },
    ): Promise<boolean> =>
      runAction(async () => {
        try {
          await runtime.forkSession(sessionId, options);
        } catch (error) {
          throw new Error(sessionActionErrorText("fork", error), { cause: error });
        }
      }),
    [runAction, runtime],
  );

  const selectDirectory = useCallback(
    async (directory: string): Promise<void> => {
      if (
        await runWorkspaceAction(async () => {
          const opened = await runtime.openFolder(directory);
          if (directoryPickerOpen === "draft") await runtime.openDraft(opened);
        })
      ) {
        setDirectoryPickerOpen(null);
      }
    },
    [directoryPickerOpen, runWorkspaceAction, runtime],
  );

  // Only the connected instance reports runs and approvals (06 §3.4).
  const activeId = view.activeSession?.id;
  const awaiting = view.pendingPermissions.length > 0;
  const running = view.composer.activeRunId !== undefined;
  const activity = useMemo(
    (): ReadonlyMap<string, SessionActivity> =>
      activeId && (awaiting || running)
        ? new Map([[activeId, awaiting ? "awaiting" : "running"]])
        : new Map(),
    [activeId, awaiting, running],
  );

  // A past chat has no usage until the daemon estimates it; ask once when the
  // chat opens so the ring shows real numbers without a click. The answer
  // arrives as a context.window.updated event.
  const hasUsage = view.header.contextWindowUsage !== null;
  useEffect(() => {
    if (!activeId || !client || hasUsage) return;
    void client
      .getContextWindowUsage({ sessionId: activeId })
      .catch(() => undefined);
  }, [activeId, client, hasUsage]);

  const sidePanel = useSidePanel(activeId);
  // Only a panel the user just opened takes focus (see SidePanel focusOnOpen).
  const [panelOpenedByUser, setPanelOpenedByUser] = useState(false);
  // Reading positions in the panel's subagent details; a new chat starts afresh.
  const panelReadingCache = useMemo<SubagentReadingCache>(
    () => new Map(),
    [activeId],
  );
  const subagentInstances = useSubagentInstances(client, activeId);
  const terminalDirectory = useCallback(
    () => runtime.terminalDirectory(),
    [runtime],
  );
  const terminalTabs = useTerminalTabs({
    api: runtime.terminals,
    panel: sidePanel,
    directory: terminalDirectory,
    onError: pushError,
  });
  // A side chat reads the main chat's history, so that chat must have begun:
  // a message on screen, or a first prompt already accepted (side chat 00 P17).
  const mainStarted =
    activeId !== undefined &&
    (!view.isEmpty ||
      (view.snapshot?.prompts ?? []).some(
        (prompt) => prompt.sessionId === activeId,
      ));
  const sideChats = useSideChats({
    runtime,
    panel: sidePanel,
    mainSessionId: activeId,
    started: mainStarted,
    onError: pushError,
  });
  const openSideChat = sideChats.open;
  const sideChatAvailable = sideChats.unavailable === undefined;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key !== ";" ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (sideChatAvailable) openSideChat();
    };
    document.addEventListener("keydown", shortcut);
    return (): void => {
      document.removeEventListener("keydown", shortcut);
    };
  }, [openSideChat, sideChatAvailable]);
  const sidePageContext: SidePageContext = {
    client,
    rootSessionId: activeId,
    subagentReadingCache: panelReadingCache,
    subagentInstances,
    setTabState: sidePanel.setTabState,
    sessionFiles: runtime.sessionFiles,
    terminals: runtime.terminals,
    onTerminalExit: terminalTabs.markExited,
    onTerminalMissing: terminalTabs.sync,
    sideChat: sideChats.connection,
  };
  const { revealPage } = sidePanel;
  const anchorToken = useRef(0);
  // The chat's delegation entries open the instance in the right panel,
  // located at that delegation (improve-4/02 §2.7).
  const openSubagent = useCallback(
    (input: { subagentId: string; executionId: string }): void => {
      anchorToken.current += 1;
      setPanelOpenedByUser(true);
      revealPage("subagents", {
        subagentId: input.subagentId,
        anchor: { executionId: input.executionId, token: anchorToken.current },
      });
    },
    [revealPage],
  );

  const draftPicker = (
    <WorkspacePicker
      value={draft.workspaceDirectory}
      workspaces={catalog.workspaces}
      disabled={workspaceActionCount > 0}
      loadFailed={catalog.workspacesStatus === "error"}
      onChange={(directory) => {
        void runWorkspaceAction(() => runtime.openDraft(directory));
      }}
      onOpenFolder={() => {
        setDirectoryPickerOpen("draft");
      }}
      onRetry={() => {
        void runtime.refreshCatalog();
      }}
    />
  );

  return (
    <AppShell
      onSearch={openSearch}
      renderSidebar={(close, dismissDrawer) => (
        <Sidebar
          serverUrl={runtime.serverUrl}
          searchOpen={searchOpen}
          searchFocusRequest={searchFocusRequest}
          onSearchOpenChange={setSearchOpen}
          searchSessions={searchSessions}
          catalog={catalog}
          activeSessionId={view.activeSession?.id ?? null}
          activity={activity}
          disabled={view.composer.disabled}
          onCollapse={close}
          onNewChat={(workspaceDirectory) => {
            dismissDrawer();
            void runWorkspaceAction(() =>
              runtime.openDraft(workspaceDirectory),
            );
          }}
          onSelectSession={(session) => {
            dismissDrawer();
            void runAction(() =>
              runtime.openSession(session.id, session.requestDirectory),
            );
          }}
          onArchiveSession={(session) =>
            runAction(() =>
              runtime.archiveSession(session.id, session.requestDirectory),
            )
          }
          onExportSession={exportSession}
          onForkSession={(session) => {
            void forkSession(session.id, {
              directory: session.requestDirectory,
            });
          }}
          onMoveSession={(session, directory) =>
            runAction(() => runtime.moveSession(session.id, directory))
          }
          onHideWorkspace={(directory) => {
            void runAction(() => runtime.hideWorkspace(directory));
          }}
          onOpenFolder={() => {
            setDirectoryPickerOpen("sidebar");
          }}
          onRetry={() => {
            void runtime.refreshCatalog();
          }}
          onOpenSettings={(trigger) => {
            openSettings({ trigger });
          }}
          onLoadMore={(enough) => runtime.loadMoreSessions(enough)}
        />
      )}
      renderHeader={(sidebarOpen, openSidebar) => (
        <MainHeader
          sidebarOpen={sidebarOpen}
          onOpenSidebar={openSidebar}
          title={view.activeSession?.title}
          header={view.header}
          hasClient={client !== null}
          sessionId={view.activeSession?.id ?? null}
          sidePanelOpen={sidePanel.state.open}
          onOpenSidePanel={() => {
            setPanelOpenedByUser(true);
            sidePanel.setOpen(true);
          }}
          sideChat={
            client
              ? { onOpen: openSideChat, unavailable: sideChats.unavailable }
              : undefined
          }
        />
      )}
      main={
        client ? (
          <SessionScreen
            client={client}
            runtime={runtime}
            draftPicker={draftPicker}
            onOpenModelSettings={openModelSettings}
            onError={pushError}
            subagentInstances={subagentInstances.state}
            onOpenSubagent={openSubagent}
            onAskInSideChat={sideChats.quote}
            onFork={
              activeId === undefined
                ? undefined
                : (runId): Promise<boolean> => forkSession(activeId, { runId })
            }
          />
        ) : (
          <DraftFallback
            picker={draftPicker}
            reason={
              workspaceActionCount > 0
                ? "Connecting…"
                : "The default directory is not available. Choose a workspace to start."
            }
          />
        )
      }
      asideExpanded={sidePanel.state.expanded}
      aside={
        sidePanel.state.open ? (
          <SidePanel
            controls={sidePanel}
            focusOnOpen={panelOpenedByUser}
            onNewTerminal={terminalTabs.createTerminal}
            onCloseTerminal={(tab, remove) => {
              terminalTabs.closeTerminal(tab, false, remove);
            }}
            onNewSideChat={openSideChat}
            sideChatUnavailable={sideChats.unavailable}
            onCloseSideChat={sideChats.close}
            onClosed={() => {
              setPanelOpenedByUser(false);
              requestAnimationFrame(() => {
                document
                  .querySelector<HTMLElement>("[data-side-panel-toggle]")
                  ?.focus();
              });
            }}
            renderPage={(tab) => (
              <SidePanelPage key={tab.id} tab={tab} context={sidePageContext} />
            )}
          />
        ) : undefined
      }
      overlays={
        <>
          <NoticeStack
            notices={notices}
            onDismiss={(id) => {
              setNotices((current) =>
                current.filter((notice) => notice.id !== id),
              );
            }}
          />
          {terminalTabs.confirmation ? (
            <ConfirmDialog
              title="Close terminal?"
              description={`${terminalTabs.confirmation.process} is still running in this terminal. Closing it ends the program too.`}
              confirmLabel="Close"
              danger
              onConfirm={() => {
                const pending = terminalTabs.confirmation;
                if (pending)
                  terminalTabs.closeTerminal(pending.tab, true, pending.remove);
              }}
              onCancel={terminalTabs.dismissConfirmation}
            />
          ) : null}
          {settingsDialog.state.mounted ? (
            <SettingsDialog
              settings={runtime.settings}
              archive={runtime}
              state={settingsDialog.state}
              onClose={settingsDialog.close}
              onSelectSection={settingsDialog.selectSection}
              onShowNav={settingsDialog.showNav}
            />
          ) : null}
          {directoryPickerOpen !== null ? (
            <DirectoryPickerDialog
              directoryPicker={runtime}
              onClose={() => {
                setDirectoryPickerOpen(null);
              }}
              onSelect={selectDirectory}
            />
          ) : null}
        </>
      }
    />
  );
}
