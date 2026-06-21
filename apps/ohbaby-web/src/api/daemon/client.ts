import type { UiPermissionResponse } from "ohbaby-sdk";
import { FetchDaemonEventStream } from "./events.js";
import { createDaemonHttpClient, DaemonHttpClient } from "./http.js";
import type {
  OhbabyBootstrapConfig,
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
  connect(): Promise<void>;
  getSnapshot(): StoreSnapshot;
  respondPermission(
    requestId: string,
    response: UiPermissionResponse,
  ): Promise<void>;
  setPermission(input: SetPermissionRequest): Promise<void>;
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
