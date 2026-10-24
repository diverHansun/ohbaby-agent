import {
  createPermissionSync,
  createSessionSync,
  sameSessionGeneration,
  type PermissionSync,
  type SessionSync,
  type UiBackendClient,
  type UiEventHandler,
  type UiPermissionBinding,
  type UiPermissionEvent,
  type UiSessionControl,
  type UiSessionHistory,
  type UiSessionScope,
  type UiUnsubscribe,
} from "ohbaby-sdk";
import type { OhbabyWebStore } from "../../store/store.js";
import type { FetchDaemonEventStream } from "./events.js";
import type { DaemonHttpClient } from "./http.js";
import type { OhbabyBootstrapConfig, WebSseEvent } from "./wire.js";

/** Callbacks into the other client parts, kept narrow so sync owns no prompt or command state. */
export interface ClientSyncHooks {
  /** A binding became usable; unresolved prompt receipts may be queried. */
  readonly onScopeReady: () => void;
  readonly onCommandCatalogUpdated: () => void;
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

/**
 * Connection, SSE delivery, the selected-session binding and its derived
 * views (session view, history, control, index, model). The prompt and
 * command parts read the binding and tickets from here.
 */
export class ClientSync {
  readonly config: OhbabyBootstrapConfig;
  readonly http: DaemonHttpClient;
  readonly store: OhbabyWebStore;
  readonly permissionSync: PermissionSync;
  readonly sessionSync: SessionSync;
  private readonly events: FetchDaemonEventStream;
  private readonly hooks: ClientSyncHooks;
  private recoverySupportedValue = false;
  private subagentConversationSupportedValue = false;
  private scopeTicketValue = 0;
  private selectionTicket = 0;
  private modelTicketValue = 0;
  private indexTicket = 0;
  private controlTicket = 0;
  private historyTicket = 0;
  private controlValue: UiSessionControl | null = null;
  private readonly permissionHandlers = new Set<{
    handler: (event: UiPermissionEvent) => void;
    onError?: (error: unknown) => void;
  }>();
  private connectionGeneration = 0;
  private transportLive = false;
  private readonly eventHandlers = new Set<UiEventHandler>();
  private readonly lifecycleController = new AbortController();
  private connectPromise: Promise<void> | undefined;
  private connected = false;
  private closedValue = false;

  constructor(input: {
    readonly config: OhbabyBootstrapConfig;
    readonly events: FetchDaemonEventStream;
    readonly http: DaemonHttpClient;
    readonly store: OhbabyWebStore;
    readonly hooks: ClientSyncHooks;
  }) {
    this.config = input.config;
    this.events = input.events;
    this.http = input.http;
    this.store = input.store;
    this.hooks = input.hooks;
    this.sessionSync = createSessionSync({
      query: async (scope, signal) =>
        (await this.http.getSessionView({ ...scope, signal })).view,
      onChange: (state) => {
        if (this.closedValue) return;
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

  get closed(): boolean {
    return this.closedValue;
  }
  // A method, not the getter, so narrowing does not survive an await.
  private isClosed(): boolean {
    return this.closedValue;
  }
  get signal(): AbortSignal {
    return this.lifecycleController.signal;
  }
  get binding(): UiPermissionBinding | null {
    return this.permissionSync.getState().binding ?? null;
  }
  get recoverySupported(): boolean {
    return this.recoverySupportedValue;
  }
  get subagentConversationSupported(): boolean {
    return this.subagentConversationSupportedValue;
  }
  /** Changes whenever the selected session binding changes. */
  get scopeTicket(): number {
    return this.scopeTicketValue;
  }
  get control(): UiSessionControl | null {
    return this.controlValue;
  }
  get modelTicket(): number {
    return this.modelTicketValue;
  }
  /** Model writes and reads share one ticket so the latest one wins. */
  nextModelTicket(): number {
    return ++this.modelTicketValue;
  }

  async connect(): Promise<void> {
    if (this.closedValue) {
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
          if (this.closedValue) return;
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
          if (this.closedValue) return;
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

  async close(): Promise<void> {
    this.closedValue = true;
    this.connected = false;
    this.lifecycleController.abort();
    this.permissionSync.dispose();
    this.sessionSync.dispose();
    this.permissionHandlers.clear();
    this.store.clearCommands();
    await this.events.close();
    this.store.setConnectionState("disconnected");
  }

  refreshUnrelatedViews(): void {
    void this.refreshModel();
    void this.refreshIndex();
  }

  private async refreshModel(): Promise<void> {
    const ticket = this.nextModelTicket();
    const scope = this.scopeTicketValue;
    try {
      const response = await this.http.getCurrentModel({
        signal: this.lifecycleController.signal,
      });
      if (
        !this.closedValue &&
        ticket === this.modelTicketValue &&
        scope === this.scopeTicketValue
      )
        this.store.setCurrentModel(response.model);
    } catch (error) {
      if (
        !this.closedValue &&
        ticket === this.modelTicketValue &&
        scope === this.scopeTicketValue
      )
        this.store.setError(errorMessage(error));
    }
  }

  async refreshIndex(): Promise<void> {
    const ticket = ++this.indexTicket;
    const scope = this.scopeTicketValue;
    try {
      const sessions = await this.getSessionIndex();
      if (
        !this.closedValue &&
        ticket === this.indexTicket &&
        scope === this.scopeTicketValue
      )
        this.store.setSessionIndex(sessions);
    } catch (error) {
      if (
        !this.closedValue &&
        ticket === this.indexTicket &&
        scope === this.scopeTicketValue
      )
        this.store.setError(errorMessage(error));
    }
  }

  async getSessionIndex(): ReturnType<UiBackendClient["getSessionIndex"]> {
    return (
      await this.http.getSessionIndex({
        signal: this.lifecycleController.signal,
      })
    ).sessions;
  }

  acceptBinding(
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
      ++this.scopeTicketValue;
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
      this.hooks.onScopeReady();
      this.refreshUnrelatedViews();
      return;
    }
    if (this.transportLive)
      this.permissionSync.begin(binding, this.connectionGeneration);
    if (binding.sessionRecoveryVersion !== undefined || fromHello) {
      this.recoverySupportedValue =
        binding.sessionRecoveryVersion === 1 &&
        binding.runtimeEpoch === binding.permissionEpoch;
    }
    if (binding.subagentConversationVersion !== undefined || fromHello)
      this.subagentConversationSupportedValue =
        binding.subagentConversationVersion === 1 &&
        binding.runtimeEpoch === binding.permissionEpoch;
    if (!this.recoverySupportedValue) {
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
    this.hooks.onScopeReady();
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

  currentScope(): UiSessionScope | null {
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
    this.controlValue = null;
    this.store.setSessionControl(null);
  }

  async refreshControl(): Promise<void> {
    const scope = this.currentScope();
    if (!this.transportLive || !this.recoverySupportedValue || !scope) {
      this.clearControl();
      return;
    }
    const scopeTicket = this.scopeTicketValue;
    const ticket = ++this.controlTicket;
    try {
      const control = (
        await this.http.getSessionControl({
          ...scope,
          signal: this.lifecycleController.signal,
        })
      ).control;
      if (
        this.closedValue ||
        scopeTicket !== this.scopeTicketValue ||
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
      this.controlValue = control;
      this.store.setSessionControl(control);
    } catch {
      if (
        !this.closedValue &&
        scopeTicket === this.scopeTicketValue &&
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
    const scopeTicket = this.scopeTicketValue;
    this.store.setHistoryState("loading");
    try {
      const history: UiSessionHistory = (
        await this.http.getSessionHistory({
          ...scope,
          before,
          signal: this.lifecycleController.signal,
        })
      ).history;
      const current = this.sessionSync.getState().view;
      if (
        this.closedValue ||
        scopeTicket !== this.scopeTicketValue ||
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
        !this.closedValue &&
        scopeTicket === this.scopeTicketValue &&
        ticket === this.historyTicket
      )
        this.store.setHistoryState("error", errorMessage(error));
    }
  }

  async createSession(
    input?: Parameters<UiBackendClient["createSession"]>[0],
  ): ReturnType<UiBackendClient["createSession"]> {
    const ticket = ++this.selectionTicket;
    const response = await this.http.createSession(input);
    if (!this.closedValue && ticket === this.selectionTicket)
      this.acceptBinding(response);
    this.refreshUnrelatedViews();
    return { ...response.session, created: response.created };
  }

  async selectSession(sessionId: string): Promise<void> {
    const ticket = ++this.selectionTicket;
    const response = await this.http.selectSession(sessionId);
    if (!this.closedValue && ticket === this.selectionTicket)
      this.acceptBinding(response);
    this.refreshUnrelatedViews();
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

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private handleSseEvent(event: WebSseEvent, seqNum: number | undefined): void {
    if (this.closedValue) {
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
      this.hooks.onCommandCatalogUpdated();
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
