import { Folder, FolderPlus } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { WorkspaceSnapshot } from "../api/daemon/wire.js";
import type { OhbabyWebRuntime } from "../runtime.js";
import { SessionScreen } from "./session/SessionScreen.js";
import { ErrorBanner, StatusPill } from "./session/SessionStatus.js";
import { DirectoryPickerDialog } from "./workspace/directory-picker/DirectoryPickerDialog.js";
import { ProjectRail } from "./workspace/ProjectRail.js";

interface AppProps {
  readonly runtime: OhbabyWebRuntime;
}

let mountedRoot: Root | undefined;

export function mountOhbabyWebApp(runtime: OhbabyWebRuntime): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Missing #root element");
  }
  mountedRoot?.unmount();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(<OhbabyWebApp runtime={runtime} />);
}

export function mountBootstrapError(error: unknown): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    return;
  }
  mountedRoot?.unmount();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(<BootstrapError error={error} />);
}

export function OhbabyWebApp({ runtime }: AppProps): ReactElement {
  const workspace = useSyncExternalStore(
    (listener) => runtime.subscribeWorkspaces(listener),
    () => runtime.getWorkspaceSnapshot(),
    () => runtime.getWorkspaceSnapshot(),
  );
  const client = runtime.client;
  return workspace.selectedDirectory === null || client === null ? (
    <EmptyWorkspaceApp runtime={runtime} workspace={workspace} />
  ) : (
    <SessionScreen client={client} runtime={runtime} />
  );
}

function EmptyWorkspaceApp(props: {
  readonly runtime: OhbabyWebRuntime;
  readonly workspace: WorkspaceSnapshot;
}): ReactElement {
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => {
    try {
      setError(null);
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, []);
  const openDirectoryPicker = useCallback((): void => {
    setError(null);
    setDirectoryPickerOpen(true);
  }, []);
  const selectDirectory = useCallback(
    async (directory: string): Promise<void> => {
      if (await run(() => props.runtime.openWorkspace(directory))) {
        setDirectoryPickerOpen(false);
      }
    },
    [props.runtime, run],
  );
  return (
    <main className="ohb-app ohb-app-shell ohb-app-empty ohb-project-empty">
      <ProjectRail
        onAdd={openDirectoryPicker}
        onHide={(directory) => {
          void run(() => props.runtime.hideWorkspace(directory));
        }}
        onSelect={(directory) => {
          void run(() => props.runtime.switchWorkspace(directory));
        }}
        workspace={props.workspace}
      />
      <section className="ohb-app-content ohb-app-content-empty">
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
        <div className="ohb-project-empty-message">
          <span className="ohb-project-empty-icon">
            <Folder size={24} />
          </span>
          <h1>Open a project to get started</h1>
          <p>Projects stay in this rail even before they have a session.</p>
          <button onClick={openDirectoryPicker} type="button">
            <FolderPlus size={16} /> Open project
          </button>
        </div>
      </section>
      {directoryPickerOpen ? (
        <DirectoryPickerDialog
          directoryPicker={props.runtime}
          onClose={() => {
            setDirectoryPickerOpen(false);
          }}
          onSelect={selectDirectory}
        />
      ) : null}
    </main>
  );
}

function BootstrapError(props: { readonly error: unknown }): ReactElement {
  const message =
    props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <main className="ohb-app ohb-app-empty">
      <div className="ohb-bootstrap-error" role="alert">
        <StatusPill kind="disconnected" />
        <p>{message}</p>
      </div>
    </main>
  );
}

export { visibleMessageText } from "./conversation/MessageRow.js";
