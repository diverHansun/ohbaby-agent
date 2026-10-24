import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { ProjectPicker } from "../composer/ProjectPicker.js";
import { DraftFallback } from "../session/DraftFallback.js";
import { selectViewModel } from "../session/selectors.js";
import { SessionScreen } from "../session/SessionScreen.js";
import { downloadTextFile } from "../shared/download-file.js";
import { type NoticeItem, NoticeStack } from "../shared/Notice.js";
import { Sidebar } from "../sidebar/Sidebar.js";
import type { SessionExportFormat } from "../sidebar/SessionActionsMenu.js";
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
  const [notices, setNotices] = useState<readonly NoticeItem[]>([]);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
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
    (sessionId: string, format: SessionExportFormat): void => {
      void runAction(async () => {
        try {
          downloadTextFile(await runtime.exportSession(sessionId, format));
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
          await runtime.openDraft(await runtime.openFolder(directory));
        })
      ) {
        setDirectoryPickerOpen(false);
      }
    },
    [runWorkspaceAction, runtime],
  );

  const draftPicker = (
    <ProjectPicker
      value={draft.projectDirectory}
      projects={catalog.projects}
      disabled={workspaceActionCount > 0}
      loadFailed={catalog.projectsStatus === "error"}
      onChange={(directory) => {
        void runWorkspaceAction(() => runtime.openDraft(directory));
      }}
      onOpenFolder={() => {
        setDirectoryPickerOpen(true);
      }}
      onRetry={() => {
        void runtime.refreshCatalog();
      }}
    />
  );

  return (
    <AppShell
      renderSidebar={(close, dismissDrawer) => (
        <Sidebar
          serverUrl={runtime.serverUrl}
          view={view}
          workspace={workspace}
          onCollapse={close}
          onCreateSession={() => {
            dismissDrawer();
            void runAction(() => runtime.openDraft(null));
          }}
          onSelectSession={(sessionId) => {
            dismissDrawer();
            void runAction(() => runtime.openSession(sessionId));
          }}
          onArchiveSession={(sessionId) =>
            runAction(() => runtime.archiveSession(sessionId))
          }
          onExportSession={exportSession}
          onSwitchProject={(directory) => {
            void runWorkspaceAction(() => runtime.openDraft(directory));
          }}
          onHideProject={(directory) => {
            void runAction(() => runtime.hideWorkspace(directory));
          }}
          onOpenFolder={() => {
            setDirectoryPickerOpen(true);
          }}
        />
      )}
      renderHeader={(sidebarOpen, openSidebar) => (
        <MainHeader
          sidebarOpen={sidebarOpen}
          onOpenSidebar={openSidebar}
          title={view.activeSession?.title}
          workingDirectory={
            view.activeSession?.projectRoot ??
            workspace.selectedDirectory ??
            undefined
          }
          header={view.header}
          hasClient={client !== null}
          sessionId={view.activeSession?.id ?? null}
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
          />
        ) : (
          <DraftFallback
            picker={draftPicker}
            reason={
              workspaceActionCount > 0
                ? "Connecting…"
                : "The default workspace is not available. Choose a project to start."
            }
          />
        )
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
          {directoryPickerOpen ? (
            <DirectoryPickerDialog
              directoryPicker={runtime}
              onClose={() => {
                setDirectoryPickerOpen(false);
              }}
              onSelect={selectDirectory}
            />
          ) : null}
        </>
      }
    />
  );
}
