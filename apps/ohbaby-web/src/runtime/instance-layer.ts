import {
  createBrowserDaemonClient,
  type BrowserDaemonClient,
} from "../api/daemon/client.js";
import {
  readWebNavigationState,
  replaceNavigationHash,
  writeWebNavigationState,
  type WebNavigationState,
} from "../api/daemon/navigation-state.js";
import type { OhbabyBootstrapConfig } from "../api/daemon/wire.js";
import type { OhbabyWebStore } from "../store/store.js";
import type { GlobalLayer } from "./global-layer.js";

/**
 * The single directory-bound connection: one `BrowserDaemonClient` and its
 * SSE at a time. Switching closes the old client before the new one starts,
 * and a selection generation keeps late restores from overriding the user.
 */
export class InstanceLayer {
  private activeClient: BrowserDaemonClient | undefined;
  private disposed = false;
  private hasConnectedWorkspace = false;
  private restoringSession = false;
  private preserveRememberedSession = false;
  private sessionSelectionGeneration = 0;
  private navigationState: WebNavigationState;
  private switchPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl: typeof fetch | undefined,
    private readonly store: OhbabyWebStore,
    private readonly global: GlobalLayer,
  ) {
    this.navigationState = readWebNavigationState();
    let priorIndex = this.store.getSnapshot().sessionIndex;
    this.store.subscribe(() => {
      const index = this.store.getSnapshot().sessionIndex;
      if (index !== priorIndex) {
        priorIndex = index;
        void this.retryRememberedSelection();
      }
      this.persistActiveSession();
    });
  }

  get client(): BrowserDaemonClient | undefined {
    return this.activeClient;
  }

  get rememberedDirectory(): string | null {
    return this.navigationState.selectedDirectory;
  }

  requireClient(): BrowserDaemonClient {
    if (!this.activeClient) {
      throw new Error("No workspace is selected");
    }
    return this.activeClient;
  }

  /** An explicit user selection wins over any pending restore. */
  beginUserSelection(): void {
    this.sessionSelectionGeneration += 1;
    this.preserveRememberedSession = false;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.activeClient?.close();
    this.activeClient = undefined;
  }

  queueSwitch(directory: string, markOpened: boolean): Promise<void> {
    const pending = this.switchPromise.then(() =>
      this.doSwitch(directory, markOpened),
    );
    this.switchPromise = pending.catch(() => undefined);
    return pending;
  }

  private async doSwitch(
    directory: string,
    markOpened: boolean,
  ): Promise<void> {
    if (this.isDisposed()) return;
    let selectedDirectory = directory.trim();
    if (selectedDirectory.length === 0) {
      throw new Error("Workspace directory cannot be empty");
    }
    if (markOpened && this.global.controlPlaneAvailable) {
      selectedDirectory = await this.global.openScope(selectedDirectory);
      await this.global.refreshScopes();
    }
    const workspace = this.global.getSnapshot();
    if (selectedDirectory === workspace.selectedDirectory) {
      this.rememberSelectedDirectory(selectedDirectory);
      return;
    }
    const startupIntent = this.scopedBootstrapConfig().startupIntent;
    const rememberedSessionId =
      startupIntent?.resumeSessionId ||
      startupIntent?.startupSessionMode?.type === "fresh"
        ? undefined
        : this.navigationState.sessionByDirectory[selectedDirectory];
    const selectionGeneration = this.sessionSelectionGeneration;
    const previousDirectory = workspace.selectedDirectory;
    const previousScopes = workspace.scopes;
    const previousClient = this.activeClient;
    await previousClient?.close();
    this.store.reset();
    const nextClient = this.createClient({
      ...this.scopedBootstrapConfig(),
      clientId: this.hasConnectedWorkspace
        ? globalThis.crypto.randomUUID()
        : this.config.clientId,
      directory: selectedDirectory,
    });
    this.activeClient = nextClient;
    this.global.publish({
      scopes: this.global
        .getSnapshot()
        .scopes.map((scope) =>
          scope.directory === selectedDirectory
            ? { ...scope, loaded: true }
            : scope,
        ),
      selectedDirectory,
    });
    this.preserveRememberedSession = false;
    this.restoringSession = true;
    try {
      await nextClient.connect();
      if (this.isDisposed()) {
        await nextClient.close();
        if (this.activeClient === nextClient) this.activeClient = undefined;
        return;
      }
      this.hasConnectedWorkspace = true;
      await this.restoreRememberedSession(
        nextClient,
        rememberedSessionId,
        selectionGeneration,
      );
      if (this.global.controlPlaneAvailable) {
        await this.global.refreshScopes();
      }
      this.rememberSelectedDirectory(selectedDirectory);
    } catch (error) {
      await nextClient.close();
      if (this.isDisposed()) {
        if (this.activeClient === nextClient) this.activeClient = undefined;
        return;
      }
      this.store.reset();
      this.activeClient =
        previousDirectory === null
          ? undefined
          : this.createClient({
              ...this.scopedBootstrapConfig(),
              clientId: globalThis.crypto.randomUUID(),
              directory: previousDirectory,
            });
      this.global.publish({
        scopes: previousScopes,
        selectedDirectory: previousDirectory,
      });
      await this.activeClient?.connect().catch(() => undefined);
      throw error;
    } finally {
      this.restoringSession = false;
      // Index recovery can finish while bootstrap is still refreshing workspace
      // metadata. Its subscriber defers selection while this lock is held.
      await this.retryRememberedSelection();
      this.persistActiveSession();
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private async restoreRememberedSession(
    client: BrowserDaemonClient,
    sessionId: string | undefined,
    selectionGeneration: number,
  ): Promise<void> {
    if (!sessionId || (await client.getSelectedSessionId()) === sessionId) {
      return;
    }
    // Navigation needs only lightweight metadata, never the history/model
    // refresh that runs independently from the live permission subscription.
    const sessions = await client.getSessionIndex().catch((error: unknown) => {
      if (this.disposed || this.activeClient !== client) return [];
      // Failed metadata is not evidence that the remembered session vanished.
      // Keep that preference until a subsequent explicit user selection.
      this.preserveRememberedSession =
        this.sessionSelectionGeneration === selectionGeneration;
      this.store.setError(
        error instanceof Error ? error.message : String(error),
      );
      return [];
    });
    if (
      this.disposed ||
      this.activeClient !== client ||
      this.sessionSelectionGeneration !== selectionGeneration ||
      !sessions.some(
        (session) =>
          session.id === sessionId && !session.parentId && !session.isSubagent,
      )
    ) {
      return;
    }
    await client.selectSessionForRuntime(sessionId);
  }

  private async retryRememberedSelection(): Promise<void> {
    const client = this.activeClient;
    const directory = this.global.getSnapshot().selectedDirectory;
    if (
      this.disposed ||
      !client ||
      !directory ||
      this.restoringSession ||
      !this.preserveRememberedSession
    )
      return;
    const sessionId = this.navigationState.sessionByDirectory[directory];
    if (
      !sessionId ||
      !this.store
        .getSnapshot()
        .sessionIndex.some(
          (session) =>
            session.id === sessionId &&
            !session.parentId &&
            !session.isSubagent,
        )
    )
      return;
    const generation = this.sessionSelectionGeneration;
    this.restoringSession = true;
    try {
      await client.selectSessionForRuntime(sessionId);
      if (
        this.activeClient === client &&
        generation === this.sessionSelectionGeneration
      )
        this.preserveRememberedSession = false;
    } catch (error) {
      if (
        !this.isDisposed() &&
        this.activeClient === client &&
        generation === this.sessionSelectionGeneration
      )
        this.store.setError(errorMessage(error));
    } finally {
      if (this.activeClient === client) {
        this.restoringSession = false;
        this.persistActiveSession();
      }
    }
  }

  private persistActiveSession(): void {
    if (this.restoringSession || this.preserveRememberedSession) return;
    const directory = this.global.getSnapshot().selectedDirectory;
    const { permissionSync, view } = this.store.getSnapshot();
    // A delayed history response may still describe the previous selection.
    // The live transport binding owns the selected session when available.
    const sessionId = permissionSync.binding
      ? permissionSync.binding.rootSessionId
      : view.snapshot?.activeSessionId;
    if (!directory || !sessionId) {
      return;
    }
    this.navigationState = {
      selectedDirectory: directory,
      sessionByDirectory: {
        ...this.navigationState.sessionByDirectory,
        [directory]: sessionId,
      },
    };
    writeWebNavigationState(this.navigationState);
    replaceNavigationHash({ directory, sessionId });
  }

  private rememberSelectedDirectory(directory: string): void {
    this.navigationState = {
      ...this.navigationState,
      selectedDirectory: directory,
    };
    writeWebNavigationState(this.navigationState);
    replaceNavigationHash({
      directory,
      sessionId: this.navigationState.sessionByDirectory[directory],
    });
  }

  async clearActive(): Promise<void> {
    await this.activeClient?.close();
    this.activeClient = undefined;
    this.store.reset();
    this.navigationState = {
      ...this.navigationState,
      selectedDirectory: null,
    };
    writeWebNavigationState(this.navigationState);
    replaceNavigationHash({ directory: null });
    this.global.publish({
      scopes: this.global.getSnapshot().scopes,
      selectedDirectory: null,
    });
  }

  private createClient(config: OhbabyBootstrapConfig): BrowserDaemonClient {
    return createBrowserDaemonClient({
      config,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      store: this.store,
    });
  }

  private scopedBootstrapConfig(): OhbabyBootstrapConfig {
    if (!this.hasConnectedWorkspace) {
      return this.config;
    }
    const { startupIntent: _startupIntent, ...config } = this.config;
    return config;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
