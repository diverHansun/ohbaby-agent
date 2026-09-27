import {
  parseSlashCommandInput,
  resolveSlashCommand,
  type UiBackendClient,
  type UiSlashCommandInvocation,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import {
  createBrowserDaemonClient,
  type BrowserDaemonClient,
} from "./api/daemon/client.js";
import {
  createDaemonHttpClient,
  type DaemonHttpClient,
} from "./api/daemon/http.js";
import {
  readWebNavigationState,
  replaceNavigationHash,
  writeWebNavigationState,
  type WebNavigationState,
} from "./api/daemon/navigation-state.js";
import type {
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
  OhbabyBootstrapConfig,
  WorkspaceSnapshot,
} from "./api/daemon/wire.js";
import { createOhbabyWebStore, type OhbabyWebStore } from "./store/store.js";

export interface OhbabyWebRuntime {
  readonly client: UiBackendClient | null;
  readonly ready: Promise<void>;
  readonly store: OhbabyWebStore;
  retryPermissions(): void;
  retrySession(): void;
  loadEarlierHistory(): Promise<void>;
  retryUnknownPrompts(): Promise<void>;
  forgetUnknownPrompt(clientRequestId: string): void;
  abortSession(sessionId: string, runId?: string): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  createSession(): Promise<void>;
  dispose(): Promise<void>;
  executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<void>;
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse>;
  hideWorkspace(directory: string): Promise<void>;
  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse>;
  listWebCommands(): Promise<UiWebCommandCatalog>;
  openWorkspace(directory: string): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  subscribeWorkspaces(listener: () => void): () => void;
  switchWorkspace(directory: string): Promise<void>;
}

function createClientInvocationId(): string {
  return globalThis.crypto.randomUUID();
}

class BrowserOhbabyWebRuntime implements OhbabyWebRuntime {
  readonly store = createOhbabyWebStore();
  readonly ready: Promise<void>;
  private activeClient: BrowserDaemonClient | undefined;
  private readonly globalHttp: DaemonHttpClient;
  private readonly listeners = new Set<() => void>();
  private controlPlaneAvailable = true;
  private disposed = false;
  private hasConnectedWorkspace = false;
  private restoringSession = false;
  private preserveRememberedSession = false;
  private sessionSelectionGeneration = 0;
  private navigationState: WebNavigationState;
  private switchPromise: Promise<void> = Promise.resolve();
  private workspaceSnapshot: WorkspaceSnapshot;

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl: typeof fetch | undefined,
  ) {
    this.globalHttp = createDaemonHttpClient(
      { ...config, directory: undefined },
      fetchImpl,
    );
    this.navigationState = readWebNavigationState();
    this.workspaceSnapshot = {
      scopes: [],
      selectedDirectory: null,
    };
    let priorIndex = this.store.getSnapshot().sessionIndex;
    this.store.subscribe(() => {
      const index = this.store.getSnapshot().sessionIndex;
      if (index !== priorIndex) {
        priorIndex = index;
        void this.retryRememberedSelection();
      }
      this.persistActiveSession();
    });
    this.ready = this.initialize();
  }

  get client(): UiBackendClient | null {
    return this.activeClient ?? null;
  }

  retryPermissions(): void {
    this.activeClient?.retryPermissions();
  }
  retrySession(): void {
    this.activeClient?.retrySession();
  }
  async loadEarlierHistory(): Promise<void> {
    await this.activeClient?.loadEarlierHistory();
  }
  async retryUnknownPrompts(): Promise<void> {
    await this.activeClient?.retryUnknownPrompts();
  }
  forgetUnknownPrompt(clientRequestId: string): void {
    this.activeClient?.forgetUnknownPrompt(clientRequestId);
  }

  async createSession(): Promise<void> {
    this.sessionSelectionGeneration += 1;
    this.preserveRememberedSession = false;
    await this.requireActiveClient().createSessionForRuntime();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.activeClient?.close();
    this.activeClient = undefined;
  }

  async selectSession(sessionId: string): Promise<void> {
    this.sessionSelectionGeneration += 1;
    this.preserveRememberedSession = false;
    await this.requireActiveClient().selectSessionForRuntime(sessionId);
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.requireActiveClient().archiveSession({ sessionId });
  }

  async abortSession(sessionId: string, runId?: string): Promise<void> {
    await this.requireActiveClient().abortSessionForRuntime(sessionId, runId);
  }

  async executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<void> {
    const client = this.requireActiveClient();
    const catalog = await client.listWebCommandsForRuntime();
    const resolved = resolveSlashCommand(
      catalog,
      parseSlashCommandInput(input.text),
      { surface: "tui" },
    );
    if (!resolved.ok) {
      throw new Error(resolved.error.message);
    }
    const webCommand = catalog.commands.find(
      (command) => command.id === resolved.command.id,
    );
    if (
      webCommand?.executionKind === "overlay" &&
      input.allowOverlay !== true
    ) {
      throw new Error(`Command "${input.text}" must be opened from the UI`);
    }
    if (resolved.command.id === "new" || resolved.command.id === "resume") {
      this.sessionSelectionGeneration += 1;
      this.preserveRememberedSession = false;
    }
    await client.executeCommand({
      argumentMode: resolved.command.argumentMode,
      argv: resolved.argv,
      body: resolved.body,
      clientInvocationId: createClientInvocationId(),
      commandId: resolved.command.id,
      path: resolved.path,
      raw: resolved.raw,
      rawArgs: resolved.rawArgs,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      surface: "tui",
    } satisfies UiSlashCommandInvocation);
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return this.workspaceSnapshot;
  }

  subscribeWorkspaces(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refreshWorkspaces(): Promise<void> {
    const response = await this.globalHttp.listWorkspaceScopes();
    const scopes = response.scopes;
    this.publishWorkspaceSnapshot({
      scopes,
      selectedDirectory: this.workspaceSnapshot.selectedDirectory,
    });
  }

  async openWorkspace(directory: string): Promise<void> {
    const response = await this.globalHttp.openWorkspace(directory);
    await this.refreshWorkspaces();
    await this.queueSwitchWorkspace(response.scope.directory, false);
  }

  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse> {
    return this.globalHttp.getDirectoryPickerRoots();
  }

  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse> {
    return this.globalHttp.listDirectoryPicker(directory);
  }

  listWebCommands(): Promise<UiWebCommandCatalog> {
    return this.requireActiveClient().listWebCommandsForRuntime();
  }

  async hideWorkspace(directory: string): Promise<void> {
    await this.globalHttp.hideWorkspace(directory);
    const wasSelected = this.workspaceSnapshot.selectedDirectory === directory;
    await this.refreshWorkspaces();
    if (!wasSelected) {
      return;
    }
    const next = this.workspaceSnapshot.scopes.find((scope) => scope.available);
    if (next) {
      await this.queueSwitchWorkspace(next.directory, false);
      return;
    }
    await this.clearActiveWorkspace();
  }

  switchWorkspace(directory: string): Promise<void> {
    return this.queueSwitchWorkspace(directory, true);
  }

  private queueSwitchWorkspace(
    directory: string,
    markOpened: boolean,
  ): Promise<void> {
    const pending = this.switchPromise.then(() =>
      this.doSwitchWorkspace(directory, markOpened),
    );
    this.switchPromise = pending.catch(() => undefined);
    return pending;
  }

  private async doSwitchWorkspace(
    directory: string,
    markOpened: boolean,
  ): Promise<void> {
    if (this.isDisposed()) return;
    let selectedDirectory = directory.trim();
    if (selectedDirectory.length === 0) {
      throw new Error("Workspace directory cannot be empty");
    }
    if (markOpened && this.controlPlaneAvailable) {
      selectedDirectory = (
        await this.globalHttp.openWorkspace(selectedDirectory)
      ).scope.directory;
      await this.refreshWorkspaces();
    }
    if (selectedDirectory === this.workspaceSnapshot.selectedDirectory) {
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
    const previousDirectory = this.workspaceSnapshot.selectedDirectory;
    const previousScopes = this.workspaceSnapshot.scopes;
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
    this.publishWorkspaceSnapshot({
      scopes: this.workspaceSnapshot.scopes.map((scope) =>
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
      if (this.controlPlaneAvailable) {
        await this.refreshWorkspaces();
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
      this.publishWorkspaceSnapshot({
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

  private async initialize(): Promise<void> {
    const hintedDirectory = this.config.directory?.trim();
    try {
      await this.refreshWorkspaces();
    } catch (error) {
      if (!hintedDirectory) {
        throw error;
      }
      this.controlPlaneAvailable = false;
      this.publishWorkspaceSnapshot({
        scopes: [
          {
            available: true,
            directory: hintedDirectory,
            lastOpenedAt: 0,
            loaded: true,
            position: 0,
          },
        ],
        selectedDirectory: null,
      });
      await this.queueSwitchWorkspace(hintedDirectory, false);
      return;
    }
    let selectedDirectory: string | undefined;
    if (hintedDirectory) {
      const visibleHint = this.workspaceSnapshot.scopes.find(
        (scope) => scope.directory === hintedDirectory && scope.available,
      );
      if (visibleHint) {
        selectedDirectory = visibleHint.directory;
      } else {
        selectedDirectory = (
          await this.globalHttp.openWorkspace(hintedDirectory)
        ).scope.directory;
        await this.refreshWorkspaces();
      }
    } else {
      const remembered = this.navigationState.selectedDirectory;
      selectedDirectory = this.workspaceSnapshot.scopes.find(
        (scope) => scope.directory === remembered && scope.available,
      )?.directory;
      selectedDirectory ??= [...this.workspaceSnapshot.scopes]
        .filter((scope) => scope.available)
        .sort(
          (left, right) =>
            right.lastOpenedAt - left.lastOpenedAt ||
            left.position - right.position,
        )[0]?.directory;
    }
    if (selectedDirectory) {
      await this.queueSwitchWorkspace(selectedDirectory, false);
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
    const directory = this.workspaceSnapshot.selectedDirectory;
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
    const directory = this.workspaceSnapshot.selectedDirectory;
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

  private async clearActiveWorkspace(): Promise<void> {
    await this.activeClient?.close();
    this.activeClient = undefined;
    this.store.reset();
    this.navigationState = {
      ...this.navigationState,
      selectedDirectory: null,
    };
    writeWebNavigationState(this.navigationState);
    replaceNavigationHash({ directory: null });
    this.publishWorkspaceSnapshot({
      scopes: this.workspaceSnapshot.scopes,
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

  private requireActiveClient(): BrowserDaemonClient {
    if (!this.activeClient) {
      throw new Error("No workspace is selected");
    }
    return this.activeClient;
  }

  private scopedBootstrapConfig(): OhbabyBootstrapConfig {
    if (!this.hasConnectedWorkspace) {
      return this.config;
    }
    const { startupIntent: _startupIntent, ...config } = this.config;
    return config;
  }

  private publishWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
    this.workspaceSnapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createOhbabyWebRuntime(
  config: OhbabyBootstrapConfig,
  options: { readonly fetch?: typeof fetch } = {},
): OhbabyWebRuntime {
  return new BrowserOhbabyWebRuntime(config, options.fetch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
