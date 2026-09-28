import type {
  UiSubagentQuery,
  UiSubagentExecutionList,
  UiSubagentExecutionView,
  UiSubagentConversationQuery,
  UiSubagentConversationView,
  UiSubagentConversationSelection,
  UiSubagentConversationUnwatchQuery,
} from "ohbaby-sdk";
import {
  createPermissionSync,
  createSessionSync,
  sameSessionGeneration,
  type SessionSync,
  type UiSessionScope,
  type UiSessionHistory,
  type UiPromptReceiptQuery,
  type UiSessionControl,
  type UiSessionView,
  type UiPromptReceiptResult,
  type PermissionSync,
  type UiPermissionBinding,
  type UiPermissionEvent,
  submitPromptAndWait as composeSubmitPromptAndWait,
  type SubmitPromptOptions,
  type UiBackendClient,
  type UiEventHandler,
  type UiPromptCompletion,
  type UiPromptReceipt,
  type UiUnsubscribe,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import { FetchDaemonEventStream } from "./events.js";
import { createDaemonHttpClient, DaemonHttpClient } from "./http.js";
import type {
  OhbabyBootstrapConfig,
  WebSseEvent,
  UnknownPromptRequest,
} from "./wire.js";
import type { OhbabyWebStore } from "../../store/store.js";

function reportEventSubscriberFailure(): void {
  try {
    globalThis.console.error(
      '{"stage":"event-subscriber","type":"ui.observation.failure"}',
    );
  } catch {
    // Diagnostics are fail-open and must not affect event delivery.
  }
}

export class BrowserDaemonClient implements UiBackendClient {
  private readonly config: OhbabyBootstrapConfig;
  private readonly events: FetchDaemonEventStream;
  private readonly http: DaemonHttpClient;
  private readonly store: OhbabyWebStore;
  private readonly permissionSync: PermissionSync;
  private readonly sessionSync: SessionSync;
  private recoverySupported = false;
  private subagentConversationSupported = false;
  private scopeTicket = 0;
  private selectionTicket = 0;
  private modelTicket = 0;
  private indexTicket = 0;
  private controlTicket = 0;
  private historyTicket = 0;
  private receiptTicket = 0;
  private control: UiSessionControl | null = null;
  private unknownPrompts: UnknownPromptRequest[] = [];
  private readonly submittingPrompts = new Set<string>();
  private persistedUnknownIds = new Set<string>();
  private readonly permissionHandlers = new Set<{
    handler: (event: UiPermissionEvent) => void;
    onError?: (error: unknown) => void;
  }>();
  private connectionGeneration = 0;
  private transportLive = false;
  private readonly eventHandlers = new Set<UiEventHandler>();
  private readonly lifecycleController = new AbortController();
  private readonly commandCatalogPromises = new Map<
    string,
    Promise<UiWebCommandCatalog>
  >();
  private connectPromise: Promise<void> | undefined;
  private connected = false;
  private closed = false;

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
    this.unknownPrompts = readUnknownPrompts(this.config.directory ?? "");
    this.persistedUnknownIds = new Set(
      this.unknownPrompts.map((request) => request.clientRequestId),
    );
    this.store.setUnknownPromptRequests(this.unknownPrompts);
    this.sessionSync = createSessionSync({
      query: async (scope, signal) =>
        (await this.http.getSessionView({ ...scope, signal })).view,
      onChange: (state) => {
        if (this.closed) return;
        const becameReady =
          state.status === "ready" &&
          this.store.getSnapshot().sessionSync.status !== "ready";
        this.store.setSessionSync(state);
        if (becameReady) void this.refreshControl();
      },
    });
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
            this.sessionSync.disconnect();
            this.clearControl();
            this.notifyConversationResync(true);
          }
          this.store.setConnectionState(state);
        },
        onError: (error) => {
          if (this.closed) return;
          this.transportLive = false;
          this.permissionSync.disconnect();
          this.sessionSync.disconnect();
          this.clearControl();
          this.notifyConversationResync(true);
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
  }

  private refreshUnrelatedViews(): void {
    void this.refreshModel();
    void this.refreshIndex();
  }

  private async refreshModel(): Promise<void> {
    const ticket = ++this.modelTicket;
    const scope = this.scopeTicket;
    try {
      const response = await this.http.getCurrentModel({
        signal: this.lifecycleController.signal,
      });
      if (
        !this.closed &&
        ticket === this.modelTicket &&
        scope === this.scopeTicket
      )
        this.store.setCurrentModel(response.model);
    } catch (error) {
      if (
        !this.closed &&
        ticket === this.modelTicket &&
        scope === this.scopeTicket
      )
        this.store.setError(errorMessage(error));
    }
  }

  private async refreshIndex(): Promise<void> {
    const ticket = ++this.indexTicket;
    const scope = this.scopeTicket;
    try {
      const sessions = await this.getSessionIndex();
      if (
        !this.closed &&
        ticket === this.indexTicket &&
        scope === this.scopeTicket
      )
        this.store.setSessionIndex(sessions);
    } catch (error) {
      if (
        !this.closed &&
        ticket === this.indexTicket &&
        scope === this.scopeTicket
      )
        this.store.setError(errorMessage(error));
    }
  }

  private acceptBinding(
    binding: UiPermissionBinding & {
      readonly runtimeEpoch?: string;
      readonly sessionRecoveryVersion?: number;
      readonly subagentConversationVersion?: number;
    },
    fromHello = false,
  ): void {
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
    const changed =
      previous?.rootSessionId !== binding.rootSessionId ||
      previous.bindingGeneration !== binding.bindingGeneration ||
      previous.permissionEpoch !== binding.permissionEpoch;
    if (changed) {
      ++this.scopeTicket;
      ++this.historyTicket;
      this.clearControl();
    } else if (!fromHello) {
      // Same scope (for example New session reusing the current empty session,
      // or a prompt receipt): the live chat and approval subscriptions are
      // still valid, so restarting them would only flash a recovery state.
      const sync = this.sessionSync.getState();
      if (this.transportLive && binding.rootSessionId) {
        if (sync.status === "error") this.sessionSync.retry();
        else if (sync.status === "idle")
          this.sessionSync.begin(
            this.currentScope(),
            this.connectionGeneration,
          );
      }
      if (
        this.transportLive &&
        this.permissionSync.getState().status === "error"
      )
        this.permissionSync.retry();
      void this.refreshControl();
      void this.retryUnknownPrompts();
      this.refreshUnrelatedViews();
      return;
    }
    if (this.transportLive)
      this.permissionSync.begin(binding, this.connectionGeneration);
    if (binding.sessionRecoveryVersion !== undefined || fromHello) {
      this.recoverySupported =
        binding.sessionRecoveryVersion === 1 &&
        binding.runtimeEpoch === binding.permissionEpoch;
    }
    if (binding.subagentConversationVersion !== undefined || fromHello)
      this.subagentConversationSupported =
        binding.subagentConversationVersion === 1 &&
        binding.runtimeEpoch === binding.permissionEpoch;
    if (!this.recoverySupported) {
      this.sessionSync.disconnect();
      this.store.setSessionSync({
        status: "error",
        scope: null,
        attempts: 0,
        error: "Server does not support session recovery version 1",
      });
      return;
    }
    if (this.transportLive)
      this.sessionSync.begin(this.currentScope(), this.connectionGeneration);
    void this.refreshControl();
    void this.retryUnknownPrompts();
    this.refreshUnrelatedViews();
    if (fromHello) this.notifyConversationResync(false);
  }

  private notifyConversationResync(disconnected: boolean): void {
    const binding = this.permissionSync.getState().binding;
    if (!binding) return;
    this.notifyUiEvent({
      type: "session.resync-required",
      runtimeEpoch: binding.permissionEpoch,
      sessionId: binding.rootSessionId,
      bindingGeneration: binding.bindingGeneration,
      connectionGeneration: this.connectionGeneration,
      disconnected,
    });
  }

  private currentScope(): UiSessionScope | null {
    const binding = this.permissionSync.getState().binding;
    return binding?.rootSessionId
      ? {
          sessionId: binding.rootSessionId,
          runtimeEpoch: binding.permissionEpoch,
          bindingGeneration: binding.bindingGeneration,
        }
      : null;
  }

  private clearControl(): void {
    ++this.controlTicket;
    this.control = null;
    this.store.setSessionControl(null);
  }

  private async refreshControl(): Promise<void> {
    const scope = this.currentScope();
    if (!this.transportLive || !this.recoverySupported || !scope) {
      this.clearControl();
      return;
    }
    const scopeTicket = this.scopeTicket;
    const ticket = ++this.controlTicket;
    try {
      const control = await this.getSessionControl({
        ...scope,
        signal: this.lifecycleController.signal,
      });
      if (
        this.closed ||
        scopeTicket !== this.scopeTicket ||
        ticket !== this.controlTicket
      )
        return;
      if (
        control.runtimeEpoch !== scope.runtimeEpoch ||
        control.sessionId !== scope.sessionId ||
        control.rootSessionId !== scope.sessionId ||
        control.bindingGeneration !== scope.bindingGeneration
      )
        throw new Error("Session control scope changed");
      this.control = control;
      this.store.setSessionControl(control);
    } catch {
      if (
        !this.closed &&
        scopeTicket === this.scopeTicket &&
        ticket === this.controlTicket
      )
        this.clearControl();
    }
  }

  retrySession(): void {
    this.sessionSync.retry();
    void this.refreshControl();
  }

  async loadEarlierHistory(): Promise<void> {
    const state = this.sessionSync.getState();
    const scope = this.currentScope();
    if (!scope || state.status !== "ready" || !state.view) return;
    const stored = this.store.getSnapshot();
    const before = stored.historyStale
      ? state.view.history.before
      : stored.historyBefore;
    if (!before) return;
    const ticket = ++this.historyTicket;
    const scopeTicket = this.scopeTicket;
    this.store.setHistoryState("loading");
    try {
      const history = await this.getSessionHistory({
        ...scope,
        before,
        signal: this.lifecycleController.signal,
      });
      const current = this.sessionSync.getState().view;
      if (
        this.closed ||
        scopeTicket !== this.scopeTicket ||
        ticket !== this.historyTicket
      )
        return;
      if (
        !current ||
        history.bindingGeneration !== scope.bindingGeneration ||
        !sameSessionGeneration(history.version, current.version)
      )
        throw new Error("History changed while loading; retry the page");
      this.store.installSessionHistory(history);
      this.store.setHistoryState("ready");
    } catch (error) {
      if (
        !this.closed &&
        scopeTicket === this.scopeTicket &&
        ticket === this.historyTicket
      )
        this.store.setHistoryState("error", errorMessage(error));
    }
  }

  async listSubagentExecutions(
    input: UiSubagentQuery,
  ): Promise<UiSubagentExecutionList> {
    const binding = this.permissionSync.getState().binding;
    const result = await this.http.listSubagentExecutions({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.permissionSync.getState().binding)
      throw new Error("Session binding changed during execution query");
    return result.result;
  }
  async getSubagentExecutionView(
    input: UiSubagentQuery & { executionId: string },
  ): Promise<UiSubagentExecutionView> {
    const binding = this.permissionSync.getState().binding;
    const result = await this.http.getSubagentExecutionView({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.permissionSync.getState().binding)
      throw new Error("Session binding changed during execution query");
    return result.result;
  }
  async getSubagentConversationView(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationView> {
    if (!this.subagentConversationSupported)
      throw new Error("Server does not support subagent conversations");
    const binding = this.permissionSync.getState().binding;
    const result = await this.http.getSubagentConversationView({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.permissionSync.getState().binding)
      throw new Error("Session binding changed during conversation query");
    return result.result;
  }
  async watchSubagentConversation(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationSelection> {
    if (!this.subagentConversationSupported)
      throw new Error("Server does not support subagent conversations");
    const binding = this.permissionSync.getState().binding;
    const result = await this.http.watchSubagentConversation({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.permissionSync.getState().binding)
      throw new Error("Session binding changed during conversation watch");
    return result.result;
  }
  async unwatchSubagentConversation(
    input: UiSubagentConversationUnwatchQuery,
  ): Promise<void> {
    await this.http.unwatchSubagentConversation(input);
  }
  async getSessionView(input: UiSessionScope): Promise<UiSessionView> {
    return (await this.http.getSessionView(input)).view;
  }
  async getSessionHistory(
    input: UiSessionScope & {
      readonly before?: string;
      readonly limit?: number;
    },
  ): Promise<UiSessionHistory> {
    return (await this.http.getSessionHistory(input)).history;
  }
  async getSessionControl(input: UiSessionScope): Promise<UiSessionControl> {
    return (await this.http.getSessionControl(input)).control;
  }
  async getPromptReceipt(
    input: UiPromptReceiptQuery,
  ): Promise<UiPromptReceiptResult> {
    return (await this.http.getPromptReceipt(input)).result;
  }

  private publishUnknownPrompts(): void {
    writeUnknownPrompts(
      this.config.directory ?? "",
      this.unknownPrompts,
      this.persistedUnknownIds,
    );
    this.persistedUnknownIds = new Set(
      this.unknownPrompts.map((request) => request.clientRequestId),
    );
    if (!this.closed)
      this.store.setUnknownPromptRequests(
        this.unknownPrompts.map((request) => ({
          ...request,
          submitting: this.submittingPrompts.has(request.clientRequestId),
        })),
      );
  }

  forgetUnknownPrompt(clientRequestId: string): void {
    if (this.submittingPrompts.has(clientRequestId)) return;
    this.unknownPrompts = this.unknownPrompts.filter(
      (request) => request.clientRequestId !== clientRequestId,
    );
    this.publishUnknownPrompts();
  }

  async retryUnknownPrompts(): Promise<void> {
    const binding = this.permissionSync.getState().binding;
    if (!binding || !this.recoverySupported || this.closed) return;
    const ticket = ++this.receiptTicket;
    for (const request of [...this.unknownPrompts]) {
      if (request.runtimeEpoch !== binding.permissionEpoch) {
        this.unknownPrompts = this.unknownPrompts.map((value) =>
          value.clientRequestId === request.clientRequestId
            ? { ...value, status: "epoch-changed" }
            : value,
        );
        this.publishUnknownPrompts();
        continue;
      }
      try {
        const result = await this.getPromptReceipt({
          clientRequestId: request.clientRequestId,
          sessionId: request.sessionId,
          runtimeEpoch: request.runtimeEpoch,
          bindingGeneration: binding.bindingGeneration,
          signal: this.lifecycleController.signal,
        });
        if (
          this.lifecycleController.signal.aborted ||
          ticket !== this.receiptTicket ||
          binding.bindingGeneration !==
            this.permissionSync.getState().binding?.bindingGeneration
        )
          return;
        if (
          result.runtimeEpoch !== request.runtimeEpoch ||
          result.bindingGeneration !== binding.bindingGeneration ||
          result.clientRequestId !== request.clientRequestId
        )
          continue;
        if (result.receipt) {
          this.unknownPrompts = this.unknownPrompts.filter(
            (value) => value.clientRequestId !== request.clientRequestId,
          );
          this.publishUnknownPrompts();
          if (this.currentScope()?.sessionId === result.receipt.sessionId)
            this.sessionSync.resync();
        }
      } catch {
        /* An unknown result stays unknown. Never resend or navigate. */
      }
    }
  }

  retryPermissions(): void {
    this.permissionSync.retry();
  }

  getSelectedSessionId(): ReturnType<UiBackendClient["getSelectedSessionId"]> {
    return Promise.resolve(
      this.permissionSync.getState().binding?.rootSessionId ?? null,
    );
  }

  async createSession(
    input?: Parameters<UiBackendClient["createSession"]>[0],
  ): ReturnType<UiBackendClient["createSession"]> {
    const ticket = ++this.selectionTicket;
    const response = await this.http.createSession(input);
    if (!this.closed && ticket === this.selectionTicket)
      this.acceptBinding(response);
    this.refreshUnrelatedViews();
    return { ...response.session, created: response.created };
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
    this.sessionSync.dispose();
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
    const binding = this.permissionSync.getState().binding;
    if (
      !this.recoverySupported ||
      !binding ||
      (binding.rootSessionId !== null &&
        this.sessionSync.getState().status !== "ready")
    )
      throw new Error("Session is not synchronized");
    const clientRequestId =
      options?.clientRequestId ?? globalThis.crypto.randomUUID();
    if (
      this.unknownPrompts.some(
        (request) => request.clientRequestId === clientRequestId,
      )
    )
      throw new Error(
        "Prompt result is unknown; query its receipt before submitting again",
      );
    const scopeTicket = this.scopeTicket;
    const sessionId = options?.sessionId ?? binding.rootSessionId ?? undefined;
    if (sessionId !== (binding.rootSessionId ?? undefined))
      throw new Error("Selected session changed before submission");
    if (
      this.unknownPrompts.some(
        (request) =>
          request.sessionId === sessionId && request.status !== "epoch-changed",
      )
    )
      throw new Error(
        "A prompt result is unknown for this session; query its receipt before submitting again",
      );
    this.submittingPrompts.add(clientRequestId);
    this.unknownPrompts = [
      ...this.unknownPrompts,
      {
        directory: this.config.directory ?? "",
        runtimeEpoch: binding.permissionEpoch,
        clientRequestId,
        sessionId,
        status: "unknown",
      },
    ];
    this.publishUnknownPrompts();
    try {
      const { ok: _ok, ...receipt } = await this.http.submitPromptAccepted({
        clientRequestId,
        sessionId,
        text,
        ...(options?.reasoning === undefined
          ? {}
          : { reasoning: options.reasoning }),
      });
      this.unknownPrompts = this.unknownPrompts.filter(
        (request) => request.clientRequestId !== clientRequestId,
      );
      this.publishUnknownPrompts();
      if (
        !this.closed &&
        scopeTicket === this.scopeTicket &&
        "permissionEpoch" in receipt &&
        "rootSessionId" in receipt &&
        "bindingGeneration" in receipt
      )
        this.acceptBinding(receipt as typeof receipt & UiPermissionBinding);
      return receipt;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        [
          "QUEUE_FULL",
          "INVALID_CLIENT_REQUEST_ID",
          "PROMPT_SCHEDULER_CLOSED",
          "IDEMPOTENCY_CONFLICT",
          "PROMPT_SUBMISSION_REJECTED",
        ].includes(String(error.code))
      ) {
        this.unknownPrompts = this.unknownPrompts.filter(
          (request) => request.clientRequestId !== clientRequestId,
        );
        this.publishUnknownPrompts();
      }
      throw error;
    } finally {
      this.submittingPrompts.delete(clientRequestId);
      this.publishUnknownPrompts();
    }
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

  async steerQueuedPrompt(
    input: Parameters<UiBackendClient["steerQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["steerQueuedPrompt"]> {
    return (
      await this.http.steerQueuedPrompt(
        input.promptId,
        input.expectedRunId,
        input.clientRequestId,
      )
    ).receipt;
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
    const scopeTicket = this.scopeTicket;
    const ticket = ++this.modelTicket;
    const response = await this.http.connectModel(input);
    if (
      !this.closed &&
      scopeTicket === this.scopeTicket &&
      ticket === this.modelTicket
    )
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
    this.sessionSync.resync();
    void this.refreshIndex();
  }

  createSessionForRuntime(): ReturnType<UiBackendClient["createSession"]> {
    return this.createSession({
      reuseInactiveEmpty: { excludeSessionIds: [] },
    });
  }

  async selectSessionForRuntime(sessionId: string): Promise<void> {
    const ticket = ++this.selectionTicket;
    const response = await this.http.selectSession(sessionId);
    if (!this.closed && ticket === this.selectionTicket)
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
    const target = this.control;
    if (target?.runId !== runId)
      throw new Error("The exact running task has not been verified");
    await this.http.abortSession(target.sessionId, {
      runId,
      runtimeEpoch: target.runtimeEpoch,
      bindingGeneration: target.bindingGeneration,
    });
    await this.refreshControl();
  }
  async abortSessionForRuntime(
    sessionId: string,
    runId?: string,
  ): Promise<void> {
    const target = this.control;
    if (
      target?.sessionId !== sessionId ||
      !target.runId ||
      (runId !== undefined && target.runId !== runId)
    )
      throw new Error("The exact running task has not been verified");
    await this.abortRun(target.runId);
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
        this.sessionSync.resync();
        this.notifyConversationResync(false);
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
          event.event.type === "session.changed" ||
          event.event.type === "session.unavailable"
        ) {
          if (event.event.type === "session.changed")
            this.store.invalidateSessionHistory(event.event);
          this.sessionSync.receive(event.event);
          if (event.event.type === "session.changed" && event.event.runs)
            void this.refreshControl();
          this.notifyUiEvent(event.event);
          if (
            seqNum !== undefined &&
            Number.isSafeInteger(seqNum) &&
            seqNum >= 0
          )
            this.events.setLastEventId(seqNum);
          return;
        }
        if (event.event.type === "session.index.invalidated") {
          void this.refreshIndex();
          return;
        }
        if (event.event.type === "model.invalidated") {
          void this.refreshModel();
          return;
        }
        if (event.event.type === "session.resync-required") {
          this.sessionSync.resync();
          this.notifyUiEvent(event.event);
          return;
        }
        if (
          event.event.type === "subagent.conversation.changed" ||
          event.event.type === "subagent.conversation.unavailable"
        ) {
          if (
            seqNum === undefined ||
            !Number.isSafeInteger(seqNum) ||
            seqNum < 0
          ) {
            this.store.setError("Daemon event is missing a valid sequence id");
            return;
          }
          this.notifyUiEvent(event.event);
          this.events.setLastEventId(seqNum);
          return;
        }
        if (event.event.type === "snapshot.replaced") return;
        if (
          [
            "message.appended",
            "message.updated",
            "message.part.delta",
            "message.reasoning.delta",
            "message.reasoning.end",
            "session.updated",
            "session.archived",
            "run.updated",
            "run.interrupted",
            "prompt.submitted",
            "prompt.updated",
            "todo.updated",
            "goal.updated",
            "context.window.updated",
          ].includes(event.event.type)
        ) {
          this.notifyUiEvent(event.event);
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
        if (this.dispatchUiEvent(event.event, seqNum, "incremental"))
          this.events.setLastEventId(seqNum);
      }
    }
  }

  private notifyUiEvent(event: Parameters<UiEventHandler>[0]): void {
    let failed = false;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        failed = true;
      }
    }
    if (failed) reportEventSubscriberFailure();
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

export function createBrowserDaemonClient(input: {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const UNKNOWN_PROMPTS_KEY = "ohbaby.web.unknown-prompts.v1";
function readUnknownPrompts(directory: string): UnknownPromptRequest[] {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return [];
    const prefix = `${UNKNOWN_PROMPTS_KEY}:${encodeURIComponent(directory)}:`;
    const result: UnknownPromptRequest[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (typeof value !== "object" || value === null) continue;
      const record = value as Partial<UnknownPromptRequest>;
      if (
        record.directory === directory &&
        typeof record.clientRequestId === "string" &&
        typeof record.runtimeEpoch === "string" &&
        (record.sessionId === undefined ||
          typeof record.sessionId === "string") &&
        (record.status === "unknown" || record.status === "epoch-changed")
      )
        result.push(record as UnknownPromptRequest);
    }
    return result;
  } catch {
    return [];
  }
}
function writeUnknownPrompts(
  directory: string,
  requests: readonly UnknownPromptRequest[],
  previousIds: ReadonlySet<string>,
): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return;
    const prefix = `${UNKNOWN_PROMPTS_KEY}:${encodeURIComponent(directory)}:`;
    const ids = new Set(requests.map((request) => request.clientRequestId));
    for (const id of previousIds)
      if (!ids.has(id))
        storage.removeItem(`${prefix}${encodeURIComponent(id)}`);
    for (const request of requests)
      storage.setItem(
        `${prefix}${encodeURIComponent(request.clientRequestId)}`,
        JSON.stringify(request),
      );
  } catch {
    /* The active client still retains the unresolved identity in memory. */
  }
}
