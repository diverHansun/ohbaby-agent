import {
  parseSlashCommandInput,
  resolveSlashCommand,
  filterWebPassthroughCommandCatalog,
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
  close(): Promise<void>;
  compactSession(
    sessionId: string,
    input?: CompactSessionRequest,
  ): Promise<UiCompactSessionResult>;
  connect(): Promise<void>;
  connectModel(input: ModelConnectRequest): Promise<UiConnectModelResult>;
  createSession(): Promise<void>;
  executeSlashCommand(input: {
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<void>;
  getContextWindowUsage(
    sessionId: string,
  ): Promise<UiContextWindowUsage | null>;
  getCurrentModel(): Promise<UiCurrentModelConfig | null>;
  getSnapshot(): StoreSnapshot;
  listCommands(): Promise<UiWebCommandCatalog>;
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
    this.connected = false;
    await this.events.close();
    this.store.setConnectionState("disconnected");
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
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<void> {
    const catalog = await this.listCommands();
    const passthroughCatalog = filterWebPassthroughCommandCatalog(catalog, {
      surface: "tui",
    });
    const resolved = resolveSlashCommand(
      passthroughCatalog,
      parseSlashCommandInput(input.text),
      { surface: "tui" },
    );
    if (!resolved.ok) {
      throw new Error(resolved.error.message);
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
  }

  async selectSession(sessionId: string): Promise<void> {
    await this.http.selectSession(sessionId);
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

  private async doResync(lastEventId: number): Promise<void> {
    const previousBuffering = this.buffering;
    this.buffering = true;
    this.store.setConnectionState("resyncing");
    try {
      const response = await this.http.getSnapshot();
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

export function createOhbabyWebRuntime(
  config: OhbabyBootstrapConfig,
  options: { readonly fetch?: typeof fetch } = {},
): OhbabyWebRuntime {
  const store = createOhbabyWebStore();
  const http = createDaemonHttpClient(config, options.fetch);
  const events = new FetchDaemonEventStream({
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    token: config.token,
  });
  const client = new BrowserDaemonClient({
    config,
    events,
    http,
    store,
  });
  return {
    client,
    ready: client.connect(),
    store,
  };
}
