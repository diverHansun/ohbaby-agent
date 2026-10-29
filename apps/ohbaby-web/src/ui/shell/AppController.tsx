import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
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
import { SidePanel } from "../side-panel/SidePanel.js";
import {
  type SidePageContext,
  SidePanelPage,
} from "../side-panel/SidePanelPage.js";
import { useSidePanel } from "../side-panel/use-side-panel.js";
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
  const workspace = useSyncExternalStore(
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

  const sidePanel = useSidePanel(activeId);
  // Reading positions in the panel's subagent details; a new chat starts afresh.
  const panelReadingCache = useMemo<SubagentReadingCache>(
    () => new Map(),
    [activeId],
  );
  const sidePageContext: SidePageContext = {
    client,
    rootSessionId: activeId,
    subagentReadingCache: panelReadingCache,
    setTabState: sidePanel.setTabState,
  };

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
          workingDirectory={
            view.activeSession?.workingDirectory ??
            workspace.selectedDirectory ??
            undefined
          }
          header={view.header}
          hasClient={client !== null}
          sessionId={view.activeSession?.id ?? null}
          sidePanelOpen={sidePanel.state.open}
          onOpenSidePanel={() => {
            sidePanel.setOpen(true);
          }}
          onOpenContextUsage={() => {
            const sessionId = view.activeSession?.id;
            if (sessionId && client)
              void client
                .getContextWindowUsage({ sessionId })
                .catch(() => undefined);
          }}
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
            onClosed={() => {
              requestAnimationFrame(() => {
                document
                  .querySelector<HTMLElement>("[data-side-panel-toggle]")
                  ?.focus();
              });
            }}
            renderPage={(tab) => (
              <SidePanelPage tab={tab} context={sidePageContext} />
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
