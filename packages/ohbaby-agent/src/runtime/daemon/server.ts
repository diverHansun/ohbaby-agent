import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiEvent,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { SessionRunBusyError } from "../run-ledger/index.js";
import { isAuthorizedDaemonRequest } from "./auth.js";
import { PermissionRouter } from "./permission-router.js";
import { DaemonPromptQueue } from "./prompt-queue.js";
import {
  createDaemonRpcFailure,
  createDaemonRpcSuccess,
  parseDaemonRpcRequest,
  type DaemonRpcRequest,
  type DaemonRpcResponse,
  type DaemonSseEvent,
  type DaemonStartupIntent,
} from "./protocol.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

interface SseClient {
  readonly clientId: string;
  readonly response: ServerResponse;
}

interface ClientView {
  readonly activeSessionId?: string | null;
  readonly initialPermission?: DaemonStartupIntent["initialPermission"];
}

export interface DaemonHttpServerOptions {
  readonly backend: UiBackendClient;
  readonly authToken?: string;
  readonly host?: string;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
  readonly promptQueue?: DaemonPromptQueue;
}

export interface DaemonHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type NormalizedDaemonHttpServerOptions = Omit<
  DaemonHttpServerOptions,
  "host" | "permissionRouter" | "port"
> & {
  readonly host: string;
  readonly permissionRouter: PermissionRouter;
  readonly port: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

class DaemonForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonForbiddenError";
  }
}

function isDaemonForbiddenError(error: unknown): error is DaemonForbiddenError {
  return error instanceof DaemonForbiddenError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function submitPromptOptions(value: unknown): SubmitPromptOptions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
  };
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

function requestChunkToBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error("Unexpected request body chunk");
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = requestChunkToBuffer(chunk);
    chunks.push(buffer);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
  }
  return Buffer.concat(chunks, size).toString("utf8");
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
  clientViews: Map<string, ClientView>,
  permissionRouter: PermissionRouter,
  promptQueue: DaemonPromptQueue,
  request: DaemonRpcRequest,
): Promise<unknown> {
  switch (request.method) {
    case "getSnapshot": {
      const snapshot = await backend.getSnapshot();
      return permissionRouter.filterSnapshotForClient(
        snapshotForClient(snapshot, clientViews.get(request.clientId)),
        request.clientId,
      );
    }
    case "initializeClient": {
      const intent = parseStartupIntent(request.params[0]);
      const snapshot = await backend.getSnapshot();
      clientViews.set(request.clientId, {
        activeSessionId: resolveStartupActiveSessionId(snapshot, intent),
        ...(intent.initialPermission === undefined
          ? {}
          : { initialPermission: intent.initialPermission }),
      });
      return undefined;
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
      const options = submitPromptOptions(request.params[1]);
      const submitOptions = optionsForClientSubmit(
        options,
        clientViews.get(request.clientId),
      );
      await promptQueue.enqueue({
        clientId: request.clientId,
        ...(submitOptions === undefined ? {} : { options: submitOptions }),
        ...(submitOptions?.sessionId === undefined
          ? {}
          : { sessionId: submitOptions.sessionId }),
        text: request.params[0] as string,
      });
      return undefined;
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
      if (
        !permissionRouter.canRespondPermission(
          request.params[0] as string,
          request.clientId,
        )
      ) {
        throw new DaemonForbiddenError(
          "Permission request is owned by another client",
        );
      }
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

function parseStartupIntent(value: unknown): DaemonStartupIntent {
  if (!isRecord(value)) {
    return {};
  }
  const startupSessionMode = isRecord(value.startupSessionMode) &&
    value.startupSessionMode.type === "continue"
      ? ({ type: "continue" } as const)
      : undefined;
  const resumeSessionId =
    typeof value.resumeSessionId === "string" ? value.resumeSessionId : undefined;
  const rawInitialPermission = value.initialPermission;
  let initialPermission: DaemonStartupIntent["initialPermission"];
  if (isRecord(rawInitialPermission)) {
    const level = rawInitialPermission.level;
    const mode = rawInitialPermission.mode;
    if (
      (level === "default" || level === "full-access") &&
      (mode === "plan" || mode === "auto")
    ) {
      initialPermission = { level, mode };
    }
  }

  return {
    ...(startupSessionMode === undefined ? {} : { startupSessionMode }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(initialPermission === undefined ? {} : { initialPermission }),
  };
}

function resolveStartupActiveSessionId(
  snapshot: UiSnapshot,
  intent: DaemonStartupIntent,
): string | null {
  if (intent.resumeSessionId !== undefined) {
    if (!snapshot.sessions.some((session) => session.id === intent.resumeSessionId)) {
      throw new Error(`Session not found: ${intent.resumeSessionId}`);
    }
    return intent.resumeSessionId;
  }
  if (intent.startupSessionMode?.type === "continue") {
    if (snapshot.sessions.length === 0) {
      return null;
    }
    const latest = [...snapshot.sessions].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0];
    return latest.id;
  }
  return null;
}

function snapshotForClient(
  snapshot: UiSnapshot,
  view: ClientView | undefined,
): UiSnapshot {
  if (!view) {
    return snapshot;
  }
  return {
    ...snapshot,
    ...(view.activeSessionId === undefined
      ? {}
      : { activeSessionId: view.activeSessionId }),
    ...(view.initialPermission === undefined
      ? {}
      : {
          permission: {
            level: view.initialPermission.level,
            mode: view.initialPermission.mode,
            sessionRules: snapshot.permission?.sessionRules ?? [],
          },
        }),
  };
}

function optionsForClientSubmit(
  options: SubmitPromptOptions | undefined,
  view: ClientView | undefined,
): SubmitPromptOptions | undefined {
  if (options?.sessionId !== undefined) {
    return options;
  }
  if (view?.activeSessionId) {
    return { ...options, sessionId: view.activeSessionId };
  }
  return options;
}

function createDefaultPromptQueue(
  backend: UiBackendClient,
  permissionRouter: PermissionRouter,
): DaemonPromptQueue {
  return new DaemonPromptQueue({
    isBusyError: (error): boolean => error instanceof SessionRunBusyError,
    submit: async (item): Promise<void> => {
      const release = permissionRouter.trackPromptClient(
        item.clientId,
        item.sessionId,
      );
      try {
        await backend.submitPrompt(item.text, item.options);
      } finally {
        release();
      }
    },
  });
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
  private readonly clientViews = new Map<string, ClientView>();
  private readonly clients = new Set<SseClient>();
  private readonly promptQueue: DaemonPromptQueue;
  private unsubscribe: UiUnsubscribe | undefined;
  private currentPort: number;
  private started = false;

  constructor(private readonly options: NormalizedDaemonHttpServerOptions) {
    this.currentPort = options.port;
    this.promptQueue =
      options.promptQueue ??
      createDefaultPromptQueue(options.backend, options.permissionRouter);
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

    this.started = true;
    const address = this.server.address();
    if (typeof address === "object" && address !== null) {
      this.currentPort = address.port;
    }
    this.unsubscribe = this.options.backend.subscribeEvents((event) => {
      this.broadcast(event);
    });
  }

  async stop(): Promise<void> {
    this.promptQueue.shutdown("daemon stopped");
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
      writeJson(response, 200, {
        ok: true,
        ...(this.options.packageVersion === undefined
          ? {}
          : { packageVersion: this.options.packageVersion }),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/shutdown") {
      await this.handleShutdown(request, response);
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

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    return isAuthorizedDaemonRequest(
      typeof authorization === "string" ? authorization : undefined,
      this.options.authToken,
    );
  }

  private writeUnauthorized(response: ServerResponse, id = "unknown"): void {
    writeJson(response, 401, createDaemonRpcFailure(id, new Error("Unauthorized")));
  }

  private async handleShutdown(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(request)) {
      this.writeUnauthorized(response);
      return;
    }

    writeJson(response, 200, { ok: true });
    await this.options.onShutdown?.();
  }

  private async handleRpc(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(request)) {
      this.writeUnauthorized(response);
      return;
    }

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
        this.clientViews,
        this.options.permissionRouter,
        this.promptQueue,
        rpcRequest,
      );
      writeJson(response, 200, createDaemonRpcSuccess(rpcRequest.id, result));
    } catch (error) {
      const failure: DaemonRpcResponse = createDaemonRpcFailure(
        rpcRequest.id,
        error,
      );
      writeJson(response, isDaemonForbiddenError(error) ? 403 : 500, failure);
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
    if (!this.isAuthorized(request)) {
      this.writeUnauthorized(response);
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
    authToken: options.authToken,
    host: options.host ?? DEFAULT_HOST,
    onShutdown: options.onShutdown,
    packageVersion: options.packageVersion,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
    promptQueue: options.promptQueue,
  });
}
