import {
  createDaemonHttpClient,
  type DaemonHttpClient,
} from "../api/daemon/http.js";
import type {
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
  OhbabyBootstrapConfig,
  WorkspaceSnapshot,
} from "../api/daemon/wire.js";

/**
 * Directory-independent state: the project (scope) list and the folder
 * picker. Requests carry no directory header.
 */
export class GlobalLayer {
  readonly http: DaemonHttpClient;
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkspaceSnapshot = { scopes: [], selectedDirectory: null };
  /** False when the daemon serves a single workspace without scope routes. */
  controlPlaneAvailable = true;

  constructor(
    config: OhbabyBootstrapConfig,
    fetchImpl: typeof fetch | undefined,
  ) {
    this.http = createDaemonHttpClient(
      { ...config, directory: undefined },
      fetchImpl,
    );
  }

  getSnapshot(): WorkspaceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(snapshot: WorkspaceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  async refreshScopes(): Promise<void> {
    const response = await this.http.listWorkspaceScopes();
    this.publish({
      scopes: response.scopes,
      selectedDirectory: this.snapshot.selectedDirectory,
    });
  }

  /** Registers a folder as a project and returns its canonical directory. */
  async openScope(directory: string): Promise<string> {
    return (await this.http.openWorkspace(directory)).scope.directory;
  }

  hideScope(directory: string): Promise<unknown> {
    return this.http.hideWorkspace(directory);
  }

  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse> {
    return this.http.getDirectoryPickerRoots();
  }

  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse> {
    return this.http.listDirectoryPicker(directory);
  }
}
