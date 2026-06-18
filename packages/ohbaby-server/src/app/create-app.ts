import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type {
  UiBackendClient,
  UiEvent,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { isAuthorizedDaemonRequest } from "../auth/token.js";
import { DaemonClientViewCoordinator } from "../coordination/client-view.js";
import {
  EventBus,
  type EventEnvelope,
} from "../coordination/event-bus.js";
import { PermissionRouter } from "../coordination/permission-router.js";
import { DaemonPromptQueue } from "../coordination/prompt-queue.js";
import {
  callDaemonBackend,
  createDaemonRpcSuccessResponse,
  createDefaultDaemonPromptQueue,
  isDaemonForbiddenError,
  MAX_REQUEST_BODY_BYTES,
  parseDaemonRpcBody,
} from "../protocols/jsonrpc/rpc-route.js";
import {
  createDaemonRpcFailure,
  type DaemonSseEvent,
} from "../protocols/jsonrpc/protocol.js";

const encoder = new TextEncoder();
const DEFAULT_CLIENT_DISCONNECT_RETENTION_MS = 5_000;

interface SseClient {
  readonly clientId: string;
  close(): void;
  write(event: DaemonSseEvent, id?: number): void;
}

export interface DaemonServerAppOptions {
  readonly backend: UiBackendClient;
  readonly authToken?: string;
  readonly clientDisconnectRetentionMs?: number;
  readonly createSessionId?: () => string;
  readonly eventBufferCapacity?: number;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly permissionRouter?: PermissionRouter;
  readonly promptQueue?: DaemonPromptQueue;
}

export interface DaemonServerAppHandle {
  readonly app: Hono;
  dispose(): Promise<void>;
  start(): Promise<void>;
}

function writeSseFrame(event: DaemonSseEvent, id?: number): Uint8Array {
  const idLine = id === undefined ? "" : `id: ${String(id)}\n`;
  return encoder.encode(
    `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function isAuthorized(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) {
    return false;
  }
  return isAuthorizedDaemonRequest(authorization, token);
}

function requireAuthToken(token: string | undefined): string {
  if (!token) {
    throw new Error("Daemon auth token is required");
  }
  return token;
}

function normalizeClientDisconnectRetentionMs(
  value: number | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_CLIENT_DISCONNECT_RETENTION_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "clientDisconnectRetentionMs must be a non-negative finite number",
    );
  }
  return value;
}

function unauthorizedBody(id = "unknown"): unknown {
  return createDaemonRpcFailure(id, new Error("Unauthorized"));
}

function requestTooLargeBody(): unknown {
  return createDaemonRpcFailure(
    "unknown",
    new Error("Request body is too large"),
  );
}

function scheduleAfterResponse(
  callback: (() => Promise<void> | void) | undefined,
): void {
  if (!callback) {
    return;
  }
  setTimeout(() => {
    void Promise.resolve()
      .then(callback)
      .catch(() => undefined);
  }, 0);
}

type LastEventIdParseResult =
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "invalid";
    }
  | {
      readonly kind: "ok";
      readonly seqNum: number;
    };

function parseLastEventId(
  value: string | undefined,
): LastEventIdParseResult {
  if (value === undefined || value.trim().length === 0) {
    return { kind: "absent" };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { kind: "invalid" };
  }
  return { kind: "ok", seqNum: parsed };
}

async function readRequestTextWithLimit(request: Request): Promise<
  | {
      readonly body: string;
      readonly ok: true;
    }
  | {
      readonly ok: false;
    }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > MAX_REQUEST_BODY_BYTES) {
      return { ok: false };
    }
  }

  if (!request.body) {
    return { body: "", ok: true };
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> =
    request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      body += decoder.decode();
      return { body, ok: true };
    }
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    body += decoder.decode(value, { stream: true });
  }
}

class DaemonServerAppRuntime {
  readonly app = new Hono();
  private readonly clientDisconnectRetentionMs: number;
  private readonly clientViews = new DaemonClientViewCoordinator();
  private readonly clients = new Set<SseClient>();
  private readonly createSessionId: () => string;
  private readonly disconnectCleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly eventBus: EventBus;
  private readonly expiredClientIds = new Set<string>();
  private readonly knownClientIds = new Set<string>();
  private readonly authToken: string;
  private readonly permissionRouter: PermissionRouter;
  private readonly promptQueue: DaemonPromptQueue;
  private readonly replayEventsBySeqNum = new Map<number, Map<string, UiEvent>>();
  private started = false;
  private unsubscribe: UiUnsubscribe | undefined;

  constructor(private readonly options: DaemonServerAppOptions) {
    this.authToken = requireAuthToken(options.authToken);
    this.clientDisconnectRetentionMs = normalizeClientDisconnectRetentionMs(
      options.clientDisconnectRetentionMs,
    );
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.eventBus =
      options.eventBufferCapacity === undefined
        ? new EventBus()
        : new EventBus({ capacity: options.eventBufferCapacity });
    this.permissionRouter = options.permissionRouter ?? new PermissionRouter();
    this.promptQueue =
      options.promptQueue ??
      createDefaultDaemonPromptQueue(options.backend, this.permissionRouter, {
        onPromptSettled: (item) => {
          this.clientViews.promptSettled(item);
        },
        onPromptStarted: (item) => {
          this.clientViews.promptStarted(item);
        },
      });
    this.mountRoutes();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.unsubscribe = this.options.backend.subscribeEvents((event) => {
      const envelope = this.eventBus.publish(event);
      this.broadcast(envelope);
    });
    this.started = true;
  }

  dispose(): void {
    this.promptQueue.shutdown("daemon stopped");
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    for (const client of Array.from(this.clients)) {
      client.close();
    }
    this.clients.clear();
    for (const timer of this.disconnectCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectCleanupTimers.clear();
    this.expiredClientIds.clear();
    this.knownClientIds.clear();
    this.clientViews.resetRuntimeState();
    this.replayEventsBySeqNum.clear();
    this.started = false;
  }

  private mountRoutes(): void {
    this.app.get("/api/health", (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(unauthorizedBody(), 401);
      }
      return context.json({
        ok: true,
        ...(this.options.packageVersion === undefined
          ? {}
          : { packageVersion: this.options.packageVersion }),
      });
    });

    this.app.post("/api/shutdown", (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(unauthorizedBody(), 401);
      }
      scheduleAfterResponse(this.options.onShutdown);
      return context.json({ ok: true });
    });

    this.app.post("/api/rpc", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(unauthorizedBody(), 401);
      }

      const body = await readRequestTextWithLimit(context.req.raw);
      if (!body.ok) {
        return context.json(requestTooLargeBody(), 413);
      }

      const parsed = parseDaemonRpcBody(body.body);
      if (parsed.failure || !parsed.request) {
        return context.json(parsed.failure, 400);
      }

      try {
        const result = await callDaemonBackend({
          backend: this.options.backend,
          clientViews: this.clientViews,
          createSessionId: this.createSessionId,
          permissionRouter: this.permissionRouter,
          promptQueue: this.promptQueue,
          request: parsed.request,
        });
        return context.json(
          createDaemonRpcSuccessResponse(parsed.request, result),
        );
      } catch (error) {
        return context.json(
          createDaemonRpcFailure(parsed.request.id, error),
          isDaemonForbiddenError(error) ? 403 : 500,
        );
      }
    });

    this.app.get("/api/events", (context) => {
      const clientId = context.req.query("clientId");
      if (!clientId) {
        return context.json(
          { error: { message: "clientId is required" }, ok: false },
          400,
        );
      }
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(unauthorizedBody(), 401);
      }
      return this.createSseResponse(
        clientId,
        context.req.raw.signal,
        context.req.header("last-event-id"),
      );
    });
  }

  private isAuthorized(authorization: string | undefined): boolean {
    return isAuthorized(authorization, this.authToken);
  }

  private createSseResponse(
    clientId: string,
    signal: AbortSignal,
    lastEventId: string | undefined,
  ): Response {
    let client: SseClient | undefined;
    const stream = new ReadableStream<Uint8Array>({
      cancel: (_reason: unknown): void => {
        if (client) {
          this.disconnectClient(client);
        }
      },
      start: (controller): void => {
        let closed = false;
        client = {
          clientId,
          close: (): void => {
            if (closed) {
              return;
            }
            closed = true;
            try {
              controller.close();
            } catch {
              // The reader may already have cancelled the stream.
            }
          },
          write: (event, id): void => {
            if (closed) {
              return;
            }
            controller.enqueue(writeSseFrame(event, id));
          },
        };
        this.clients.add(client);
        this.cancelClientRoutingCleanup(clientId);
        this.knownClientIds.add(clientId);
        this.options.onClientConnected?.(clientId);
        client.write({ clientId, type: "hello" });
        this.replayMissedEvents(client, lastEventId);
        signal.addEventListener(
          "abort",
          (): void => {
            if (client) {
              this.disconnectClient(client);
            }
          },
          { once: true },
        );
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
      status: 200,
    });
  }

  private disconnectClient(client: SseClient): void {
    if (!this.clients.delete(client)) {
      return;
    }
    client.close();
    this.scheduleClientRoutingCleanup(client.clientId);
    this.options.onClientDisconnected?.(client.clientId);
  }

  private cancelClientRoutingCleanup(clientId: string): void {
    const timer = this.disconnectCleanupTimers.get(clientId);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.disconnectCleanupTimers.delete(clientId);
  }

  private scheduleClientRoutingCleanup(clientId: string): void {
    this.cancelClientRoutingCleanup(clientId);
    const timer = setTimeout(() => {
      this.disconnectCleanupTimers.delete(clientId);
      this.permissionRouter.disconnectClient(clientId);
      this.clientViews.disconnectClient(clientId);
      this.expiredClientIds.add(clientId);
    }, this.clientDisconnectRetentionMs);
    this.disconnectCleanupTimers.set(clientId, timer);
  }

  private replayMissedEvents(
    client: SseClient,
    lastEventId: string | undefined,
  ): void {
    const parsed = parseLastEventId(lastEventId);
    if (parsed.kind === "absent") {
      this.expiredClientIds.delete(client.clientId);
      return;
    }
    if (this.expiredClientIds.has(client.clientId)) {
      this.writeResyncRequired(client);
      this.expiredClientIds.delete(client.clientId);
      return;
    }
    if (parsed.kind === "invalid") {
      this.writeResyncRequired(client);
      return;
    }

    const replay = this.eventBus.replayAfter(parsed.seqNum);
    if (replay.kind === "resync-required") {
      this.writeResyncRequired(client);
      return;
    }

    for (const envelope of replay.envelopes) {
      this.writeReplayEnvelopeToClient(envelope, client);
    }
  }

  private writeResyncRequired(client: SseClient): void {
    client.write({
      maxSeqNum: this.eventBus.latestSeqNum,
      minSeqNum: this.eventBus.minSeqNum ?? 0,
      type: "resync-required",
    });
  }

  private broadcast(envelope: EventEnvelope): void {
    const event = envelope.event;
    this.permissionRouter.observeEvent(event);
    this.clientViews.observeEvent(event);
    const replayEvents = this.routeEnvelopeForKnownClients(envelope);
    this.replayEventsBySeqNum.set(envelope.seqNum, replayEvents);
    for (const client of Array.from(this.clients)) {
      const routed = replayEvents.get(client.clientId);
      if (routed) {
        client.write({ event: routed, type: "ui.event" }, envelope.seqNum);
      }
    }
    this.clientViews.afterEventBroadcast(event);
    this.pruneReplayEvents();
  }

  private routeEnvelopeForKnownClients(
    envelope: EventEnvelope,
  ): Map<string, UiEvent> {
    const replayEvents = new Map<string, UiEvent>();
    for (const clientId of this.knownClientIds) {
      const routed = this.routeEnvelopeForClient(envelope, clientId);
      if (routed) {
        replayEvents.set(clientId, routed);
      }
    }
    return replayEvents;
  }

  private routeEnvelopeForClient(
    envelope: EventEnvelope,
    clientId: string,
  ): UiEvent | undefined {
    const routed = this.clientViews.routeEventForClient(
      envelope.event,
      clientId,
    );
    if (!routed) {
      return undefined;
    }
    const filtered = this.permissionRouter.filterEventForClient(
      routed,
      clientId,
    );
    return filtered ?? undefined;
  }

  private writeReplayEnvelopeToClient(
    envelope: EventEnvelope,
    client: SseClient,
  ): void {
    const routed = this.replayEventsBySeqNum
      .get(envelope.seqNum)
      ?.get(client.clientId);
    if (routed) {
      client.write({ event: routed, type: "ui.event" }, envelope.seqNum);
    }
  }

  private pruneReplayEvents(): void {
    const minSeqNum = this.eventBus.minSeqNum;
    if (minSeqNum === undefined) {
      this.replayEventsBySeqNum.clear();
      return;
    }
    for (const seqNum of this.replayEventsBySeqNum.keys()) {
      if (seqNum < minSeqNum) {
        this.replayEventsBySeqNum.delete(seqNum);
      }
    }
  }
}

export function createDaemonServerApp(
  options: DaemonServerAppOptions,
): DaemonServerAppHandle {
  const runtime = new DaemonServerAppRuntime(options);
  return {
    app: runtime.app,
    dispose(): Promise<void> {
      runtime.dispose();
      return Promise.resolve();
    },
    start(): Promise<void> {
      runtime.start();
      return Promise.resolve();
    },
  };
}
