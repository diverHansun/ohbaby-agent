import {
  parseSlashCommandInput,
  resolveSlashCommand,
  type UiCompactSessionResult,
  type UiContextWindowUsage,
  type UiConnectModelResult,
  type UiCurrentModelConfig,
  type UiPermissionResponse,
  type UiSlashCommandInvocation,
  type UiProbeModelContextWindowResult,
  type UiSetSearchApiKeyResult,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import { FetchDaemonEventStream } from "./events.js";
import { createDaemonHttpClient, DaemonHttpClient } from "./http.js";
import type {
  OhbabyBootstrapConfig,
  CompactSessionRequest,
  ModelConnectRequest,
  SearchApiKeyRequest,
  SetPermissionRequest,
  StoreSnapshot,
  SubmitPromptRequest,
  WebSseEvent,
  WorkspaceScopeSummary,
  WorkspaceSnapshot,
} from "./wire.js";
import {
  createOhbabyWebStore,
  type OhbabyWebStore,
} from "../../store/store.js";

interface BufferedEvent {
  readonly event: Extract<WebSseEvent, { type: "ui.event" }>["event"];
  readonly seqNum: number;
}

export interface OhbabyWebClient {
  abortSession(sessionId: string, runId?: string): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
  compactSession(
    sessionId: string,
    input?: CompactSessionRequest,
  ): Promise<UiCompactSessionResult>;
  connect(): Promise<void>;
  connectModel(input: ModelConnectRequest): Promise<UiConnectModelResult>;
  createSession(): Promise<void>;
  executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<void>;
  getContextWindowUsage(
    sessionId: string,
  ): Promise<UiContextWindowUsage | null>;
  getCurrentModel(): Promise<UiCurrentModelConfig | null>;
  getSnapshot(): StoreSnapshot;
  listCommands(): Promise<UiWebCommandCatalog>;
  listWorkspaceScopes(): Promise<readonly WorkspaceScopeSummary[]>;
  probeModelContextWindow(
    input: ModelConnectRequest,
  ): Promise<UiProbeModelContextWindowResult>;
  respondPermission(
    requestId: string,
    response: UiPermissionResponse,
  ): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  setPermission(input: SetPermissionRequest): Promise<void>;
  setSearchApiKey(input: SearchApiKeyRequest): Promise<UiSetSearchApiKeyResult>;
  submitPrompt(input: SubmitPromptRequest): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface OhbabyWebRuntime {
  readonly client: OhbabyWebClient;
  readonly ready: Promise<void>;
  readonly store: OhbabyWebStore;
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  refreshWorkspaces(): Promise<void>;
  subscribeWorkspaces(listener: () => void): () => void;
  switchWorkspace(directory: string): Promise<void>;
}

class BrowserDaemonClient implements OhbabyWebClient {
  private readonly config: OhbabyBootstrapConfig;
  private readonly events: FetchDaemonEventStream;
  private readonly http: DaemonHttpClient;
  private readonly store: OhbabyWebStore;
  private buffering = false;
  private commandCatalogPromise: Promise<UiWebCommandCatalog> | undefined;
  private connectPromise: Promise<void> | undefined;
  private connected = false;
  private closed = false;
  private resyncPromise: Promise<void> | undefined;
  private readonly bufferedEvents: BufferedEvent[] = [];

  constructor(input: {
    readonly config: OhbabyBootstrapConfig;
    readonly events: FetchDaemonEventStream;
    readonly http: DaemonHttpClient;
    readonly store: OhbabyWebStore;
  }) {
    this.config = input.config;
    this.events = input.events;
    this.http = input.http;
    this.store = input.store;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.connected) {
      return;
    }
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.closed = false;
    this.connected = true;
    this.store.setConnectionState("connecting");
    this.store.setError(null);
    try {
      await this.http.registerClient({
        startupIntent: this.config.startupIntent,
      });
      this.buffering = true;
      await this.events.start({
        onConnectionState: (state) => {
          this.store.setConnectionState(state);
          if (state === "live") {
            this.store.setError(null);
          }
        },
        onError: (error) => {
          this.store.setError(error.message);
        },
        onEvent: (event) => this.handleSseEvent(event.payload, event.id),
      });
      const response = await this.http.getSnapshot();
      if (this.isClosed()) {
        return;
      }
      this.store.replaceSnapshot(response.snapshot, response.seqNum);
      this.applyBufferedEventsAfter(response.seqNum);
      this.buffering = false;
      this.store.setConnectionState("live");
    } catch (error) {
      this.connected = false;
      const message = error instanceof Error ? error.message : String(error);
      this.store.setError(message);
      this.store.setConnectionState("disconnected");
      await this.events.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    await this.events.close();
    this.store.setConnectionState("disconnected");
  }

  private isClosed(): boolean {
    return this.closed;
  }

  getSnapshot(): StoreSnapshot {
    return this.store.getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  async submitPrompt(input: SubmitPromptRequest): Promise<void> {
    await this.http.submitPrompt(input);
  }

  async executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<void> {
    const catalog = await this.listCommands();
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
    await this.http.executeCommand({
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

  async createSession(): Promise<void> {
    await this.http.createSession();
    await this.refreshProjectedSnapshot();
  }

  async selectSession(sessionId: string): Promise<void> {
    await this.http.selectSession(sessionId);
    await this.refreshProjectedSnapshot();
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.http.archiveSession(sessionId);
    await this.refreshProjectedSnapshot();
  }

  async listCommands(): Promise<UiWebCommandCatalog> {
    this.commandCatalogPromise ??= this.http
      .listCommands()
      .then((response) => response.catalog)
      .catch((error: unknown) => {
        this.commandCatalogPromise = undefined;
        throw error;
      });
    return this.commandCatalogPromise;
  }

  async listWorkspaceScopes(): Promise<readonly WorkspaceScopeSummary[]> {
    const response = await this.http.listWorkspaceScopes();
    return response.scopes;
  }

  async getCurrentModel(): Promise<UiCurrentModelConfig | null> {
    const response = await this.http.getCurrentModel();
    return response.model;
  }

  async probeModelContextWindow(
    input: ModelConnectRequest,
  ): Promise<UiProbeModelContextWindowResult> {
    const response = await this.http.probeModelContextWindow(input);
    return response.probe;
  }

  async connectModel(
    input: ModelConnectRequest,
  ): Promise<UiConnectModelResult> {
    const response = await this.http.connectModel(input);
    return response.model;
  }

  async setSearchApiKey(
    input: SearchApiKeyRequest,
  ): Promise<UiSetSearchApiKeyResult> {
    const response = await this.http.setSearchApiKey(input);
    return response.search;
  }

  async getContextWindowUsage(
    sessionId: string,
  ): Promise<UiContextWindowUsage | null> {
    const response = await this.http.getContextWindowUsage(sessionId);
    return response.usage;
  }

  async compactSession(
    sessionId: string,
    input: CompactSessionRequest = {},
  ): Promise<UiCompactSessionResult> {
    const response = await this.http.compactSession(sessionId, input);
    return response.compact;
  }

  async respondPermission(
    requestId: string,
    response: UiPermissionResponse,
  ): Promise<void> {
    await this.http.respondPermission(requestId, response);
  }

  async setPermission(input: SetPermissionRequest): Promise<void> {
    await this.http.setPermission(input);
  }

  async abortSession(sessionId: string, runId?: string): Promise<void> {
    await this.http.abortSession(sessionId, {
      ...(runId === undefined ? {} : { runId }),
    });
  }

  private async handleSseEvent(
    event: WebSseEvent,
    seqNum: number | undefined,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    switch (event.type) {
      case "hello":
        return;
      case "error":
        this.store.setError(event.message);
        return;
      case "resync-required":
        await this.resync(event.maxSeqNum);
        return;
      case "ui.event": {
        if (seqNum === undefined || !Number.isSafeInteger(seqNum)) {
          this.store.setError("Daemon event is missing a valid sequence id");
          return;
        }
        if (event.event.type === "command.catalog.updated") {
          this.commandCatalogPromise = undefined;
        }
        if (this.buffering) {
          this.bufferedEvents.push({ event: event.event, seqNum });
          return;
        }
        this.store.applyEvent(event.event, seqNum);
      }
    }
  }

  private async resync(lastEventId: number): Promise<void> {
    this.resyncPromise ??= this.doResync(lastEventId).finally(() => {
      this.resyncPromise = undefined;
    });
    await this.resyncPromise;
  }

  private async refreshProjectedSnapshot(): Promise<void> {
    await this.resync(this.store.getSnapshot().view.lastAppliedSeqNum);
  }

  private async doResync(lastEventId: number): Promise<void> {
    const previousBuffering = this.buffering;
    this.buffering = true;
    this.store.setConnectionState("resyncing");
    try {
      const response = await this.http.getSnapshot();
      if (this.closed) {
        return;
      }
      this.store.replaceSnapshot(response.snapshot, response.seqNum);
      const maxBufferedSeqNum = this.applyBufferedEventsAfter(response.seqNum);
      this.events.setLastEventId(
        Math.max(lastEventId, response.seqNum, maxBufferedSeqNum),
      );
      this.store.setConnectionState("live");
    } catch (error) {
      this.bufferedEvents.splice(0);
      throw error;
    } finally {
      this.buffering = previousBuffering;
    }
  }

  private applyBufferedEventsAfter(seqNum: number): number {
    let maxSeqNum = seqNum;
    for (const event of this.bufferedEvents.splice(0)) {
      if (event.seqNum > seqNum) {
        this.store.applyEvent(event.event, event.seqNum);
        maxSeqNum = Math.max(maxSeqNum, event.seqNum);
      }
    }
    return maxSeqNum;
  }
}

function createClientInvocationId(): string {
  return globalThis.crypto.randomUUID();
}

function createBrowserDaemonClient(input: {
  readonly config: OhbabyBootstrapConfig;
  readonly fetch?: typeof fetch;
  readonly store: OhbabyWebStore;
}): BrowserDaemonClient {
  const http = createDaemonHttpClient(input.config, input.fetch);
  const events = new FetchDaemonEventStream({
    baseUrl: input.config.baseUrl,
    clientId: input.config.clientId,
    directory: input.config.directory,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    token: input.config.token,
  });
  return new BrowserDaemonClient({
    config: input.config,
    events,
    http,
    store: input.store,
  });
}

class BrowserOhbabyWebRuntime implements OhbabyWebRuntime {
  readonly store = createOhbabyWebStore();
  readonly ready: Promise<void>;
  private activeClient: BrowserDaemonClient;
  private readonly listeners = new Set<() => void>();
  private switchPromise: Promise<void> = Promise.resolve();
  private workspaceSnapshot: WorkspaceSnapshot;

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl: typeof fetch | undefined,
  ) {
    const selectedDirectory = config.directory?.trim();
    if (!selectedDirectory) {
      throw new Error("Missing workspace directory in daemon bootstrap config");
    }
    this.workspaceSnapshot = {
      scopes: [{ directory: selectedDirectory, loaded: true }],
      selectedDirectory,
    };
    this.activeClient = this.createClient(config);
    this.ready = this.activeClient.connect();
  }

  get client(): OhbabyWebClient {
    return this.activeClient;
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
    const scopes = await this.activeClient.listWorkspaceScopes();
    const selectedDirectory = this.workspaceSnapshot.selectedDirectory;
    const includesSelected = scopes.some(
      (scope) => scope.directory === selectedDirectory,
    );
    this.publishWorkspaceSnapshot({
      scopes: includesSelected
        ? scopes
        : [{ directory: selectedDirectory, loaded: true }, ...scopes],
      selectedDirectory,
    });
  }

  switchWorkspace(directory: string): Promise<void> {
    const pending = this.switchPromise.then(() =>
      this.doSwitchWorkspace(directory),
    );
    this.switchPromise = pending.catch(() => undefined);
    return pending;
  }

  private async doSwitchWorkspace(directory: string): Promise<void> {
    const selectedDirectory = directory.trim();
    if (selectedDirectory.length === 0) {
      throw new Error("Workspace directory cannot be empty");
    }
    if (selectedDirectory === this.workspaceSnapshot.selectedDirectory) {
      return;
    }
    const previousDirectory = this.workspaceSnapshot.selectedDirectory;
    const previousScopes = this.workspaceSnapshot.scopes;
    const previousClient = this.activeClient;
    await previousClient.close();
    this.store.reset();
    this.activeClient = this.createClient({
      ...this.config,
      clientId: globalThis.crypto.randomUUID(),
      directory: selectedDirectory,
    });
    this.publishWorkspaceSnapshot({
      scopes: this.workspaceSnapshot.scopes.map((scope) =>
        scope.directory === selectedDirectory
          ? { ...scope, loaded: true }
          : scope,
      ),
      selectedDirectory,
    });
    try {
      await this.activeClient.connect();
      await this.refreshWorkspaces();
    } catch (error) {
      await this.activeClient.close();
      this.store.reset();
      this.activeClient = this.createClient({
        ...this.config,
        clientId: globalThis.crypto.randomUUID(),
        directory: previousDirectory,
      });
      this.publishWorkspaceSnapshot({
        scopes: previousScopes,
        selectedDirectory: previousDirectory,
      });
      await this.activeClient.connect().catch(() => undefined);
      throw error;
    }
  }

  private createClient(config: OhbabyBootstrapConfig): BrowserDaemonClient {
    return createBrowserDaemonClient({
      config,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      store: this.store,
    });
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
