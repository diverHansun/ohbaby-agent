import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type {
  UiBackendClient,
  UiEvent,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { isAuthorizedDaemonRequest } from "../auth/token.js";
import { DaemonClientViewCoordinator } from "../coordination/client-view.js";
import { PermissionRouter } from "../coordination/permission-router.js";
import { DaemonPromptQueue } from "../coordination/prompt-queue.js";
import {
  callDaemonBackend,
  createDaemonRpcSuccessResponse,
  createDefaultDaemonPromptQueue,
  isDaemonForbiddenError,
  parseDaemonRpcBody,
} from "../protocols/jsonrpc/rpc-route.js";
import {
  createDaemonRpcFailure,
  type DaemonSseEvent,
} from "../protocols/jsonrpc/protocol.js";

const encoder = new TextEncoder();

interface SseClient {
  readonly clientId: string;
  close(): void;
  write(event: DaemonSseEvent): void;
}

export interface DaemonServerAppOptions {
  readonly backend: UiBackendClient;
  readonly authToken?: string;
  readonly createSessionId?: () => string;
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

function writeSseFrame(event: DaemonSseEvent): Uint8Array {
  return encoder.encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
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

function unauthorizedBody(id = "unknown"): unknown {
  return createDaemonRpcFailure(id, new Error("Unauthorized"));
}

class DaemonServerAppRuntime {
  readonly app = new Hono();
  private readonly clientViews = new DaemonClientViewCoordinator();
  private readonly clients = new Set<SseClient>();
  private readonly createSessionId: () => string;
  private readonly permissionRouter: PermissionRouter;
  private readonly promptQueue: DaemonPromptQueue;
  private started = false;
  private unsubscribe: UiUnsubscribe | undefined;

  constructor(private readonly options: DaemonServerAppOptions) {
    this.createSessionId = options.createSessionId ?? randomUUID;
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
      this.broadcast(event);
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
    this.clientViews.resetRuntimeState();
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

    this.app.post("/api/shutdown", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(unauthorizedBody(), 401);
      }
      await this.options.onShutdown?.();
      return context.json({ ok: true });
    });

    this.app.post("/api/rpc", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(unauthorizedBody(), 401);
      }

      const parsed = parseDaemonRpcBody(await context.req.text());
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
      return this.createSseResponse(clientId, context.req.raw.signal);
    });
  }

  private isAuthorized(authorization: string | undefined): boolean {
    return isAuthorized(authorization, this.options.authToken);
  }

  private createSseResponse(
    clientId: string,
    signal: AbortSignal,
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
          write: (event): void => {
            if (closed) {
              return;
            }
            controller.enqueue(writeSseFrame(event));
          },
        };
        this.clients.add(client);
        this.options.onClientConnected?.(clientId);
        client.write({ clientId, type: "hello" });
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
    this.permissionRouter.disconnectClient(client.clientId);
    this.clientViews.disconnectClient(client.clientId);
    this.options.onClientDisconnected?.(client.clientId);
  }

  private broadcast(event: UiEvent): void {
    this.permissionRouter.observeEvent(event);
    this.clientViews.observeEvent(event);
    for (const client of Array.from(this.clients)) {
      const routed = this.clientViews.routeEventForClient(
        event,
        client.clientId,
      );
      if (!routed) {
        continue;
      }
      const filtered = this.permissionRouter.filterEventForClient(
        routed,
        client.clientId,
      );
      if (filtered) {
        client.write({ event: filtered, type: "ui.event" });
      }
    }
    this.clientViews.afterEventBroadcast(event);
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
