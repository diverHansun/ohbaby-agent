import {
  createPermissionSync,
  type PermissionSync,
  type UiPermissionBinding,
  type UiPermissionEvent,
  parseSlashCommandInput,
  resolveSlashCommand,
  submitPromptAndWait as composeSubmitPromptAndWait,
  type SubmitPromptOptions,
  type UiBackendClient,
  type UiEventHandler,
  type UiPromptCompletion,
  type UiPromptReceipt,
  type UiSnapshot,
  type UiUnsubscribe,
  type UiSlashCommandInvocation,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import { FetchDaemonEventStream } from "./events.js";
import { createDaemonHttpClient, DaemonHttpClient } from "./http.js";
import type {
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
  OhbabyBootstrapConfig,
  WebSseEvent,
  WorkspaceSnapshot,
} from "./wire.js";
import {
  createOhbabyWebStore,
  type OhbabyWebStore,
} from "../../store/store.js";
import {
  readWebNavigationState,
  replaceNavigationHash,
  writeWebNavigationState,
  type WebNavigationState,
} from "./navigation-state.js";

interface BufferedEvent {
  readonly event: Extract<WebSseEvent, { type: "ui.event" }>["event"];
  readonly seqNum: number;
}

function reportEventSubscriberFailure(): void {
  try {
    globalThis.console.error(
      '{"stage":"event-subscriber","type":"ui.observation.failure"}',
    );
  } catch {
    // Diagnostics are fail-open and must not affect event delivery.
  }
}

export interface OhbabyWebRuntime {
  readonly client: UiBackendClient | null;
  readonly ready: Promise<void>;
  readonly store: OhbabyWebStore;
  retryPermissions(): void;
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

class BrowserDaemonClient implements UiBackendClient {
  private readonly config: OhbabyBootstrapConfig;
  private readonly events: FetchDaemonEventStream;
  private readonly http: DaemonHttpClient;
  private readonly store: OhbabyWebStore;
  private readonly permissionSync: PermissionSync;
  private readonly permissionHandlers = new Set<{
    handler: (event: UiPermissionEvent) => void;
    onError?: (error: unknown) => void;
  }>();
  private connectionGeneration = 0;
  private transportLive = false;
  private readonly eventHandlers = new Set<UiEventHandler>();
  private readonly lifecycleController = new AbortController();
  private buffering = false;
  private readonly commandCatalogPromises = new Map<
    string,
    Promise<UiWebCommandCatalog>
  >();
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
    let validatedPermissionScope: string | undefined;
    this.permissionSync = createPermissionSync({
      query: async (binding, signal) => {
        const scope = JSON.stringify([
          binding.permissionEpoch,
          binding.rootSessionId,
          binding.bindingGeneration,
        ]);
        if (validatedPermissionScope !== scope) {
          const index = await this.http.getSessionIndex({ signal });
          const selected = index.sessions.find(
            (session) => session.id === binding.rootSessionId,
          );
          if (!selected || selected.parentId || selected.isSubagent) {
            throw new Error("Return to a main session to approve requests.");
          }
          validatedPermissionScope = scope;
        }
        return (await this.http.getPermissionSnapshot({ ...binding, signal }))
          .snapshot;
      },
      onChange: (state) => {
        this.store.setPermissionSync(state);
      },
    });
  }

  async connect(): Promise<void> {
    if (this.closed) {
      return;
    }
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
    this.connected = true;
    this.store.setConnectionState("connecting");
    this.store.setError(null);
    try {
      await this.http.registerClient(
        { startupIntent: this.config.startupIntent },
        { signal: this.lifecycleController.signal },
      );
      if (this.isClosed()) return;
      await this.events.start({
        onConnectionState: (state) => {
          if (this.closed) return;
          if (state === "live") {
            if (!this.transportLive) this.connectionGeneration += 1;
            this.transportLive = true;
            this.store.setError(null);
          } else {
            this.transportLive = false;
            this.permissionSync.disconnect();
          }
          this.store.setConnectionState(state);
        },
        onError: (error) => {
          if (this.closed) return;
          this.transportLive = false;
          this.permissionSync.disconnect();
          this.store.setError(error.message);
        },
        onEvent: (event) => {
          this.handleSseEvent(event.payload, event.id);
        },
      });
      if (this.isClosed()) return;
    } catch (error) {
      this.connected = false;
      if (!this.isClosed()) {
        this.store.setError(
          error instanceof Error ? error.message : String(error),
        );
        this.store.setConnectionState("disconnected");
      }
      await this.events.close();
      throw error;
    }
    // History and model failures do not own the transport or approval readiness.
    this.refreshUnrelatedViews();
  }

  private refreshUnrelatedViews(): void {
    void this.refreshProjectedSnapshot().catch((error: unknown) => {
      if (!this.closed)
        this.store.setError(
          error instanceof Error ? error.message : String(error),
        );
    });
    void this.http
      .getCurrentModel({ signal: this.lifecycleController.signal })
      .then((response) => {
        if (!this.closed) this.store.setCurrentModel(response.model);
      })
      .catch((error: unknown) => {
        if (!this.closed)
          this.store.setError(
            error instanceof Error ? error.message : String(error),
          );
      });
    void this.getSessionIndex()
      .then((sessions) => {
        if (!this.closed) this.store.setSessionIndex(sessions);
      })
      .catch((error: unknown) => {
        if (!this.closed)
          this.store.setError(
            error instanceof Error ? error.message : String(error),
          );
      });
  }

  private acceptBinding(binding: UiPermissionBinding, fromHello = false): void {
    if (
      typeof binding.permissionEpoch !== "string" ||
      !Number.isSafeInteger(binding.bindingGeneration) ||
      (binding.rootSessionId !== null &&
        typeof binding.rootSessionId !== "string")
    ) {
      this.permissionSync.disconnect();
      this.store.setError(
        "Permission subscription binding is missing or invalid",
      );
      return;
    }
    const previous = this.permissionSync.getState().binding;
    if (
      previous &&
      ((!fromHello && previous.permissionEpoch !== binding.permissionEpoch) ||
        (previous.permissionEpoch === binding.permissionEpoch &&
          previous.bindingGeneration > binding.bindingGeneration))
    )
      return;
    if (this.transportLive)
      this.permissionSync.begin(binding, this.connectionGeneration);
  }

  retryPermissions(): void {
    this.permissionSync.retry();
  }

  getSelectedSessionId(): ReturnType<UiBackendClient["getSelectedSessionId"]> {
    return Promise.resolve(
      this.permissionSync.getState().binding?.rootSessionId ?? null,
    );
  }

  createSession(): ReturnType<UiBackendClient["createSession"]> {
    return this.createSessionForRuntime();
  }

  selectSession(
    sessionId: string,
  ): ReturnType<UiBackendClient["selectSession"]> {
    return this.selectSessionForRuntime(sessionId);
  }

  async getSessionIndex(): ReturnType<UiBackendClient["getSessionIndex"]> {
    return (
      await this.http.getSessionIndex({
        signal: this.lifecycleController.signal,
      })
    ).sessions;
  }

  async getPermissionSnapshot(
    input: Parameters<UiBackendClient["getPermissionSnapshot"]>[0],
  ): ReturnType<UiBackendClient["getPermissionSnapshot"]> {
    return (
      await this.http.getPermissionSnapshot({
        ...this.permissionSync.getState().binding,
        ...input,
      })
    ).snapshot;
  }

  subscribePermissionEvents(
    handler: (event: UiPermissionEvent) => void,
    onError?: (error: unknown) => void,
  ): UiUnsubscribe {
    const subscription = { handler, onError };
    this.permissionHandlers.add(subscription);
    return () => {
      this.permissionHandlers.delete(subscription);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.lifecycleController.abort();
    this.permissionSync.dispose();
    this.permissionHandlers.clear();
    await this.events.close();
    this.store.setConnectionState("disconnected");
  }

  private isClosed(): boolean {
    return this.closed;
  }

  async getSnapshot(): ReturnType<UiBackendClient["getSnapshot"]> {
    return (await this.http.getSnapshot()).snapshot;
  }

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async submitPromptAccepted(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt> {
    const { ok: _ok, ...receipt } = await this.http.submitPromptAccepted({
      clientRequestId:
        options?.clientRequestId ?? globalThis.crypto.randomUUID(),
      ...(options?.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      text,
      ...(options?.reasoning === undefined
        ? {}
        : { reasoning: options.reasoning }),
    });
    if (
      "permissionEpoch" in receipt &&
      "rootSessionId" in receipt &&
      "bindingGeneration" in receipt
    )
      this.acceptBinding(receipt as typeof receipt & UiPermissionBinding);
    return receipt;
  }

  submitPromptAndWait(
    text: string,
    options?: Parameters<UiBackendClient["submitPromptAndWait"]>[1],
  ): Promise<UiPromptCompletion> {
    return composeSubmitPromptAndWait(this, text, options);
  }

  async waitForPrompt(
    promptId: string,
    options?: Parameters<UiBackendClient["waitForPrompt"]>[1],
  ): ReturnType<UiBackendClient["waitForPrompt"]> {
    return (await this.http.waitForPrompt(promptId, options)).completion;
  }

  async acquirePromptEditLease(
    input: Parameters<UiBackendClient["acquirePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["acquirePromptEditLease"]> {
    return (await this.http.acquirePromptEditLease(input.promptId)).lease;
  }

  async renewPromptEditLease(
    input: Parameters<UiBackendClient["renewPromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["renewPromptEditLease"]> {
    return (
      await this.http.renewPromptEditLease(input.promptId, input.editLeaseId)
    ).lease;
  }

  async releasePromptEditLease(
    input: Parameters<UiBackendClient["releasePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["releasePromptEditLease"]> {
    return (
      await this.http.releasePromptEditLease(input.promptId, input.editLeaseId)
    ).prompt;
  }

  async editQueuedPrompt(
    input: Parameters<UiBackendClient["editQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["editQueuedPrompt"]> {
    return (
      await this.http.editQueuedPrompt(
        input.promptId,
        input.editLeaseId,
        input.text,
      )
    ).prompt;
  }

  async cancelQueuedPrompt(
    input: Parameters<UiBackendClient["cancelQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
    return (
      await this.http.cancelQueuedPrompt(input.promptId, input.editLeaseId)
    ).prompt;
  }

  async listCommands(
    query: Parameters<UiBackendClient["listCommands"]>[0],
  ): ReturnType<UiBackendClient["listCommands"]> {
    const cached = this.commandCatalogPromises.get(query.surface);
    if (cached) return cached;
    const promise = this.http
      .listCommands(query.surface)
      .then((response) => response.catalog)
      .catch((error: unknown) => {
        this.commandCatalogPromises.delete(query.surface);
        throw error;
      });
    this.commandCatalogPromises.set(query.surface, promise);
    return promise;
  }

  listWebCommandsForRuntime(): Promise<UiWebCommandCatalog> {
    return this.listCommands({
      surface: "web",
    }) as Promise<UiWebCommandCatalog>;
  }

  async getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    const response = await this.http.getCurrentModel();
    return response.model;
  }

  async probeModelContextWindow(
    input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    const response = await this.http.probeModelContextWindow(input);
    return response.probe;
  }

  async connectModel(
    input: Parameters<UiBackendClient["connectModel"]>[0],
  ): ReturnType<UiBackendClient["connectModel"]> {
    const response = await this.http.connectModel(input);
    this.store.setCurrentModel(response.model);
    return response.model;
  }

  async setSearchApiKey(
    input: Parameters<UiBackendClient["setSearchApiKey"]>[0],
  ): ReturnType<UiBackendClient["setSearchApiKey"]> {
    const response = await this.http.setSearchApiKey(input);
    return response.search;
  }

  async getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
    const response = await this.http.getContextWindowUsage(input.sessionId);
    return response.usage;
  }

  async compactSession(
    options: Parameters<UiBackendClient["compactSession"]>[0] = {},
  ): ReturnType<UiBackendClient["compactSession"]> {
    const sessionId =
      options.sessionId ??
      this.store.getSnapshot().view.snapshot?.activeSessionId;
    if (!sessionId) {
      throw new Error("No session is selected");
    }
    const response = await this.http.compactSession(sessionId, {
      ...(options.force === undefined ? {} : { force: options.force }),
    });
    return response.compact;
  }

  async updateSessionReasoning(
    input: Parameters<UiBackendClient["updateSessionReasoning"]>[0],
  ): ReturnType<UiBackendClient["updateSessionReasoning"]> {
    return (await this.http.updateSessionReasoning(input)).session;
  }

  async archiveSession(
    input: Parameters<UiBackendClient["archiveSession"]>[0],
  ): ReturnType<UiBackendClient["archiveSession"]> {
    await this.http.archiveSession(input.sessionId);
    await this.refreshProjectedSnapshot();
  }

  async createSessionForRuntime(): ReturnType<
    UiBackendClient["createSession"]
  > {
    const response = await this.http.createSession();
    this.acceptBinding(response);
    this.refreshUnrelatedViews();
    return response.session;
  }

  async selectSessionForRuntime(sessionId: string): Promise<void> {
    const response = await this.http.selectSession(sessionId);
    this.acceptBinding(response);
    this.refreshUnrelatedViews();
  }

  async executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
  ): ReturnType<UiBackendClient["executeCommand"]> {
    await this.http.executeCommand(invocation);
  }

  async respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
    context?: Parameters<UiBackendClient["respondPermission"]>[2],
  ): ReturnType<UiBackendClient["respondPermission"]> {
    const state = this.permissionSync.getState();
    const binding = state.binding;
    if (
      state.status !== "ready" ||
      !binding ||
      !state.requests.some((request) => request.id === requestId)
    )
      throw new Error("Approvals are not synchronized");
    if (
      context &&
      (context.permissionEpoch !== binding.permissionEpoch ||
        context.rootSessionId !== binding.rootSessionId ||
        (context.bindingGeneration !== undefined &&
          context.bindingGeneration !== binding.bindingGeneration))
    )
      throw new Error("Permission scope changed");
    try {
      await this.http.respondPermission(requestId, {
        response,
        context: binding,
      });
    } catch (error) {
      const latest = this.permissionSync.getState().binding;
      if (
        latest?.permissionEpoch !== binding.permissionEpoch ||
        latest.rootSessionId !== binding.rootSessionId ||
        latest.bindingGeneration !== binding.bindingGeneration
      )
        return;
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "PERMISSION_NOT_PENDING") {
          this.permissionSync.resync();
          return;
        }
        if (error.code === "PERMISSION_UNAVAILABLE")
          this.permissionSync.receive({
            type: "permission.unavailable",
            ...binding,
            reason:
              error instanceof Error ? error.message : "Approvals unavailable",
          });
      }
      throw error;
    }
  }

  async respondInteraction(
    interactionId: string,
    response: Parameters<UiBackendClient["respondInteraction"]>[1],
  ): ReturnType<UiBackendClient["respondInteraction"]> {
    await this.http.respondInteraction(interactionId, response);
  }

  async setPermission(
    input: Parameters<UiBackendClient["setPermission"]>[0],
  ): ReturnType<UiBackendClient["setPermission"]> {
    return (await this.http.setPermission(input)).permission;
  }

  async abortRun(runId: string): ReturnType<UiBackendClient["abortRun"]> {
    const snapshot = this.store.getSnapshot().view.snapshot;
    const sessionId = snapshot?.runs.find((run) => run.id === runId)?.sessionId;
    if (!sessionId) {
      return;
    }
    await this.http.abortSession(sessionId, { runId });
  }

  private handleSseEvent(event: WebSseEvent, seqNum: number | undefined): void {
    if (this.closed) {
      return;
    }
    switch (event.type) {
      case "hello":
        this.acceptBinding(event, true);
        return;
      case "error":
        this.store.setError(event.message);
        return;
      case "resync-required":
        this.permissionSync.resync();
        void this.resync(event.maxSeqNum).catch((error: unknown) => {
          if (!this.closed)
            this.store.setError(
              error instanceof Error ? error.message : String(error),
            );
        });
        return;
      case "ui.event": {
        if (
          event.event.type === "permission.requested" ||
          event.event.type === "permission.resolved" ||
          event.event.type === "permission.unavailable" ||
          event.event.type === "permission.resync-required"
        ) {
          this.permissionSync.receive(event.event);
          for (const subscription of this.permissionHandlers) {
            try {
              subscription.handler(event.event);
            } catch (error) {
              this.permissionHandlers.delete(subscription);
              try {
                subscription.onError?.(error);
              } catch {
                // A failed observer must not interrupt the live event reader.
              }
            }
          }
          return;
        }
        if (
          seqNum === undefined ||
          !Number.isSafeInteger(seqNum) ||
          seqNum < 0
        ) {
          this.store.setError("Daemon event is missing a valid sequence id");
          return;
        }
        if (this.buffering) {
          this.bufferedEvents.push({ event: event.event, seqNum });
          return;
        }
        if (this.dispatchUiEvent(event.event, seqNum, "incremental")) {
          this.events.setLastEventId(seqNum);
        }
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
    let committedSeqNum = this.store.getSnapshot().view.lastAppliedSeqNum;
    try {
      let binding: string;
      let response: Awaited<ReturnType<DaemonHttpClient["getSnapshot"]>>;
      do {
        binding = JSON.stringify(this.permissionSync.getState().binding);
        response = await this.http.getSnapshot({
          signal: this.lifecycleController.signal,
        });
        if (this.closed) return;
        // A selection can finish while old history is loading. Re-read that
        // view rather than committing it or losing the coalesced refresh.
      } while (
        binding !== JSON.stringify(this.permissionSync.getState().binding)
      );
      this.dispatchUiEvent(
        { snapshot: response.snapshot, type: "snapshot.replaced" },
        response.seqNum,
        "snapshot-barrier",
      );
      const maxBufferedSeqNum = this.applyBufferedEventsAfter(response.seqNum);
      committedSeqNum = Math.max(response.seqNum, maxBufferedSeqNum);
      this.events.setLastEventId(
        Math.max(lastEventId, response.seqNum, maxBufferedSeqNum),
      );
    } catch (error) {
      // The SSE remains open for imperative resyncs. Preserve every frame that
      // arrived during the failed snapshot request and advance only to data
      // that the reducer actually committed.
      const maxBufferedSeqNum = this.applyBufferedEventsAfter(committedSeqNum);
      this.events.setLastEventId(Math.max(committedSeqNum, maxBufferedSeqNum));
      throw error;
    } finally {
      this.buffering = previousBuffering;
    }
  }

  private applyBufferedEventsAfter(seqNum: number): number {
    let maxSeqNum = seqNum;
    for (const event of this.bufferedEvents.splice(0)) {
      if (event.seqNum > seqNum) {
        this.dispatchUiEvent(event.event, event.seqNum, "incremental");
        maxSeqNum = Math.max(maxSeqNum, event.seqNum);
      }
    }
    return maxSeqNum;
  }

  private dispatchUiEvent(
    event: Parameters<UiEventHandler>[0],
    seqNum: number,
    source: "incremental" | "snapshot-barrier",
  ): boolean {
    if (!this.store.applyEvent(event, seqNum, source)) return false;
    if (event.type === "command.catalog.updated") {
      this.commandCatalogPromises.clear();
    }
    let subscriberFailed = false;
    for (const handler of Array.from(this.eventHandlers)) {
      try {
        handler(event);
      } catch {
        subscriberFailed = true;
      }
    }
    if (subscriberFailed) {
      reportEventSubscriberFailure();
    }
    return true;
  }
}

function createClientInvocationId(): string {
  return globalThis.crypto.randomUUID();
}

function activeRunForSession(
  snapshot: UiSnapshot,
  sessionId: string,
): UiSnapshot["runs"][number] | undefined {
  const status = snapshot.status;
  if (status.kind === "running") {
    const run = snapshot.runs.find(
      (candidate) => candidate.id === status.runId,
    );
    if (run?.sessionId === sessionId) {
      return run;
    }
  }
  if (status.kind === "waiting-for-permission") {
    const request = snapshot.permissions.find(
      (candidate) => candidate.id === status.requestId,
    );
    const run = snapshot.runs.find(
      (candidate) => candidate.id === request?.runId,
    );
    if (run?.sessionId === sessionId) {
      return run;
    }
  }
  return snapshot.runs.find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      (candidate.status.kind === "running" ||
        candidate.status.kind === "waiting-for-permission"),
  );
}

function isAbortableRun(snapshot: UiSnapshot, runId: string): boolean {
  const status = snapshot.status;
  if (status.kind === "running" && status.runId === runId) {
    return true;
  }
  if (
    status.kind === "waiting-for-permission" &&
    snapshot.permissions.some(
      (request) => request.id === status.requestId && request.runId === runId,
    )
  ) {
    return true;
  }
  const run = snapshot.runs.find((candidate) => candidate.id === runId);
  return (
    run?.status.kind === "running" ||
    run?.status.kind === "waiting-for-permission"
  );
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
    this.store.subscribe(() => {
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
    const snapshot = this.store.getSnapshot().view.snapshot;
    if (!snapshot) {
      return;
    }
    const run =
      runId === undefined
        ? activeRunForSession(snapshot, sessionId)
        : snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      return;
    }
    if (run.sessionId !== sessionId) {
      throw new Error(`Run ${run.id} does not belong to session ${sessionId}`);
    }
    if (!isAbortableRun(snapshot, run.id)) {
      return;
    }
    await this.requireActiveClient().abortRun(run.id);
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
