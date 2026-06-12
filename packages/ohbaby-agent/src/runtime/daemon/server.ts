import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { UiBackendClient, UiEvent, UiUnsubscribe } from "ohbaby-sdk";
import { PermissionRouter } from "./permission-router.js";
import {
  createDaemonRpcFailure,
  createDaemonRpcSuccess,
  parseDaemonRpcRequest,
  type DaemonRpcRequest,
  type DaemonRpcResponse,
  type DaemonSseEvent,
} from "./protocol.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

interface SseClient {
  readonly clientId: string;
  readonly response: ServerResponse;
}

export interface DaemonHttpServerOptions {
  readonly backend: UiBackendClient;
  readonly host?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
}

export interface DaemonHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeSse(response: ServerResponse, event: DaemonSseEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function requestChunkToString(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString("utf8");
  }
  throw new Error("Unexpected request body chunk");
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request as AsyncIterable<unknown>) {
    body += requestChunkToString(chunk);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
  }
  return body;
}

function requestIdFromBody(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string"
  ) {
    return body.id;
  }
  return "unknown";
}

async function callBackend(
  backend: UiBackendClient,
  permissionRouter: PermissionRouter,
  request: DaemonRpcRequest,
): Promise<unknown> {
  switch (request.method) {
    case "getSnapshot": {
      const snapshot = await backend.getSnapshot();
      return permissionRouter.filterSnapshotForClient(
        snapshot,
        request.clientId,
      );
    }
    case "getContextWindowUsage":
      return backend.getContextWindowUsage(
        request.params[0] as Parameters<UiBackendClient["getContextWindowUsage"]>[0],
      );
    case "listCommands":
      return backend.listCommands(
        request.params[0] as Parameters<UiBackendClient["listCommands"]>[0],
      );
    case "submitPrompt": {
      const release = permissionRouter.trackPromptClient(request.clientId);
      try {
        await backend.submitPrompt(
          request.params[0] as string,
          request.params[1] as Parameters<UiBackendClient["submitPrompt"]>[1],
        );
        return undefined;
      } finally {
        release();
      }
    }
    case "compactSession":
      return backend.compactSession(
        request.params[0] as Parameters<UiBackendClient["compactSession"]>[0],
      );
    case "getCurrentModel":
      return backend.getCurrentModel();
    case "connectModel":
      return backend.connectModel(
        request.params[0] as Parameters<UiBackendClient["connectModel"]>[0],
      );
    case "executeCommand":
      return backend.executeCommand(
        request.params[0] as Parameters<UiBackendClient["executeCommand"]>[0],
      );
    case "respondPermission":
      return backend.respondPermission(
        request.params[0] as string,
        request.params[1] as Parameters<UiBackendClient["respondPermission"]>[1],
      );
    case "respondInteraction":
      return backend.respondInteraction(
        request.params[0] as string,
        request.params[1] as Parameters<UiBackendClient["respondInteraction"]>[1],
      );
    case "abortRun":
      return backend.abortRun(request.params[0] as string | undefined);
  }
}

class DaemonHttpServer implements DaemonHttpServerHandle {
  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response).catch((error: unknown) => {
      writeJson(response, 500, {
        error: { message: errorMessage(error) },
        ok: false,
      });
    });
  });
  private readonly clients = new Set<SseClient>();
  private unsubscribe: UiUnsubscribe | undefined;
  private currentPort: number;
  private started = false;

  constructor(private readonly options: Required<DaemonHttpServerOptions>) {
    this.currentPort = options.port;
  }

  get host(): string {
    return this.options.host;
  }

  get port(): number {
    return this.currentPort;
  }

  get url(): string {
    return `http://${this.host}:${String(this.port)}`;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.options.host);
    });

    const address = this.server.address();
    if (typeof address === "object" && address !== null) {
      this.currentPort = address.port;
    }
    this.unsubscribe = this.options.backend.subscribeEvents((event) => {
      this.broadcast(event);
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    for (const client of Array.from(this.clients)) {
      client.response.end();
    }
    this.clients.clear();

    if (!this.started) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => {
        if (error && !(isNodeError(error) && error.code === "ERR_SERVER_NOT_RUNNING")) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.started = false;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rpc") {
      await this.handleRpc(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      this.handleEvents(url, request, response);
      return;
    }

    writeJson(response, 404, { error: { message: "Not found" }, ok: false });
  }

  private async handleRpc(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let parsedBody: unknown;
    let rpcRequest: DaemonRpcRequest;
    try {
      const body = await readRequestBody(request);
      parsedBody = body.length > 0 ? (JSON.parse(body) as unknown) : {};
      rpcRequest = parseDaemonRpcRequest(parsedBody);
    } catch (error) {
      const failure = createDaemonRpcFailure(requestIdFromBody(parsedBody), error);
      writeJson(response, 400, failure);
      return;
    }

    try {
      const result = await callBackend(
        this.options.backend,
        this.options.permissionRouter,
        rpcRequest,
      );
      writeJson(response, 200, createDaemonRpcSuccess(rpcRequest.id, result));
    } catch (error) {
      const failure: DaemonRpcResponse = createDaemonRpcFailure(
        rpcRequest.id,
        error,
      );
      writeJson(response, 500, failure);
    }
  }

  private handleEvents(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const clientId = url.searchParams.get("clientId");
    if (!clientId) {
      writeJson(response, 400, {
        error: { message: "clientId is required" },
        ok: false,
      });
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });

    const client: SseClient = { clientId, response };
    this.clients.add(client);
    writeSse(response, { clientId, type: "hello" });

    request.on("close", () => {
      this.clients.delete(client);
    });
  }

  private broadcast(event: UiEvent): void {
    this.options.permissionRouter.observeEvent(event);
    for (const client of Array.from(this.clients)) {
      const filtered = this.options.permissionRouter.filterEventForClient(
        event,
        client.clientId,
      );
      if (filtered) {
        writeSse(client.response, { event: filtered, type: "ui.event" });
      }
    }
  }
}

export function createDaemonHttpServer(
  options: DaemonHttpServerOptions,
): DaemonHttpServerHandle {
  return new DaemonHttpServer({
    backend: options.backend,
    host: options.host ?? DEFAULT_HOST,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
  });
}
