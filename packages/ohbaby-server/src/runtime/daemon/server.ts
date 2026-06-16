import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiEvent,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import {
  createSessionIdGenerator,
  SessionRunBusyError,
} from "ohbaby-agent";
import { isAuthorizedDaemonRequest } from "../../auth/token.js";
import { PermissionRouter } from "../../coordination/permission-router.js";
import {
  DaemonPromptQueue,
  type DaemonPromptQueueItem,
} from "../../coordination/prompt-queue.js";
import {
  createDaemonRpcFailure,
  createDaemonRpcSuccess,
  parseDaemonRpcRequest,
  type DaemonRpcRequest,
  type DaemonRpcResponse,
  type DaemonSseEvent,
  type DaemonStartupIntent,
} from "../../protocols/jsonrpc/protocol.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

interface SseClient {
  readonly clientId: string;
  readonly response: ServerResponse;
}

interface ClientView {
  activeSessionId?: string | null;
  readonly initialPermission?: DaemonStartupIntent["initialPermission"];
}

export interface DaemonHttpServerOptions {
  readonly backend: UiBackendClient;
  readonly authToken?: string;
  readonly createSessionId?: () => string;
  readonly host?: string;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
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
  "createSessionId" | "host" | "permissionRouter" | "port"
> & {
  readonly createSessionId: () => string;
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
  commandOwnersByInvocationId: Map<string, string>,
  createSessionId: () => string,
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
      const view = clientViews.get(request.clientId);
      let submitOptions = optionsForClientSubmit(
        options,
        view,
      );
      if (submitOptions?.sessionId !== undefined && view !== undefined) {
        view.activeSessionId = submitOptions.sessionId;
      } else if (view?.activeSessionId === null) {
        const sessionId = createSessionId();
        submitOptions = { ...options, sessionId };
        view.activeSessionId = sessionId;
      }
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
    case "executeCommand": {
      const invocation = commandInvocationForClient(
        request.params[0] as ExecuteCommandInvocation,
        clientViews.get(request.clientId),
      );
      if (typeof invocation.clientInvocationId === "string") {
        commandOwnersByInvocationId.set(
          invocation.clientInvocationId,
          request.clientId,
        );
      }
      return backend.executeCommand(invocation);
    }
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
  let startupSessionMode: DaemonStartupIntent["startupSessionMode"];
  if (isRecord(value.startupSessionMode)) {
    const type = value.startupSessionMode.type;
    if (type === "continue" || type === "fresh") {
      startupSessionMode = { type };
    }
  }
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
  const activeSessionId = view.activeSessionId;
  return {
    ...snapshot,
    ...(activeSessionId === undefined
      ? {}
      : { activeSessionId }),
    ...(activeSessionId === undefined
      ? {}
      : {
          ...(snapshot.contextWindowUsages === undefined
            ? {}
            : {
                contextWindowUsages: snapshot.contextWindowUsages.filter(
                  (usage) => usage.sessionId === activeSessionId,
                ),
              }),
          permissions: permissionsForClientSnapshot(snapshot, activeSessionId),
          runs: snapshot.runs.filter(
            (run) => run.sessionId === activeSessionId,
          ),
          sessions: snapshot.sessions.map((session) =>
            session.id === activeSessionId
              ? session
              : { ...session, messages: [] },
          ),
          status: statusForClientSnapshot(snapshot, activeSessionId),
        }),
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

type ExecuteCommandInvocation = Parameters<UiBackendClient["executeCommand"]>[0];

function commandInvocationForClient(
  invocation: ExecuteCommandInvocation,
  view: ClientView | undefined,
): ExecuteCommandInvocation {
  if (invocation.commandId !== "new" || view?.activeSessionId !== null) {
    return invocation;
  }
  const internalArg = "--no-reuse-empty-session";
  if (invocation.argv.includes(internalArg)) {
    return invocation;
  }
  const argv = [...invocation.argv, internalArg];
  return {
    ...invocation,
    argv,
    raw: `${invocation.raw}${invocation.raw.length > 0 ? " " : ""}${internalArg}`,
    rawArgs: argv.join(" "),
  };
}

function permissionsForClientSnapshot(
  snapshot: UiSnapshot,
  activeSessionId: string | null,
): UiSnapshot["permissions"] {
  if (activeSessionId === null) {
    return [];
  }
  return snapshot.permissions.filter((permission) => {
    const run = snapshot.runs.find(
      (candidate) => candidate.id === permission.runId,
    );
    return run?.sessionId === activeSessionId;
  });
}

function statusForClientSnapshot(
  snapshot: UiSnapshot,
  activeSessionId: string | null,
): UiSnapshot["status"] {
  const status = snapshot.status;
  if (activeSessionId === null) {
    return { kind: "idle" };
  }
  if (status.kind === "running") {
    const run = snapshot.runs.find(
      (candidate) => candidate.id === status.runId,
    );
    return run?.sessionId === activeSessionId ? status : { kind: "idle" };
  }
  if (status.kind === "waiting-for-permission") {
    const permission = snapshot.permissions.find(
      (candidate) => candidate.id === status.requestId,
    );
    const run =
      permission === undefined
        ? undefined
        : snapshot.runs.find((candidate) => candidate.id === permission.runId);
    return run?.sessionId === activeSessionId ? status : { kind: "idle" };
  }
  return status;
}

function selectedSessionIdFromCommandAction(
  action: Extract<UiEvent, { type: "command.result.delivered" }>["action"],
): string | undefined {
  if (action?.kind !== "session.selected" || !isRecord(action.data)) {
    return undefined;
  }
  const choiceId = action.data.choiceId;
  return typeof choiceId === "string" && choiceId.length > 0
    ? choiceId
    : undefined;
}

function sessionIdForEvent(event: UiEvent): string | undefined {
  switch (event.type) {
    case "session.updated":
      return event.session.id;
    case "message.appended":
    case "message.updated":
    case "message.part.delta":
    case "run.interrupted":
      return event.sessionId;
    case "run.updated":
      return event.run.sessionId;
    case "context.window.updated":
      return event.usage.sessionId;
    default:
      return undefined;
  }
}

function createDefaultPromptQueue(
  backend: UiBackendClient,
  permissionRouter: PermissionRouter,
  lifecycle: {
    readonly onPromptSettled?: (item: DaemonPromptQueueItem) => void;
    readonly onPromptStarted?: (item: DaemonPromptQueueItem) => void;
  } = {},
): DaemonPromptQueue {
  return new DaemonPromptQueue({
    isBusyError: (error): boolean => error instanceof SessionRunBusyError,
    submit: async (item): Promise<void> => {
      const release = permissionRouter.trackPromptClient(
        item.clientId,
        item.sessionId,
      );
      lifecycle.onPromptStarted?.(item);
      try {
        await backend.submitPrompt(item.text, item.options);
      } finally {
        lifecycle.onPromptSettled?.(item);
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
  private readonly commandOwnersByInvocationId = new Map<string, string>();
  private readonly commandOwnersByRunId = new Map<string, string>();
  private readonly runOwnersByRunId = new Map<string, string>();
  private readonly runSessionIdsByRunId = new Map<string, string>();
  private readonly promptQueue: DaemonPromptQueue;
  private activePrompt: DaemonPromptQueueItem | undefined;
  private unsubscribe: UiUnsubscribe | undefined;
  private currentPort: number;
  private started = false;

  constructor(private readonly options: NormalizedDaemonHttpServerOptions) {
    this.currentPort = options.port;
    this.promptQueue =
      options.promptQueue ??
      createDefaultPromptQueue(options.backend, options.permissionRouter, {
        onPromptSettled: (item) => {
          if (this.activePrompt === item) {
            this.activePrompt = undefined;
          }
        },
        onPromptStarted: (item) => {
          this.activePrompt = item;
        },
      });
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
    this.activePrompt = undefined;
    this.runOwnersByRunId.clear();
    this.runSessionIdsByRunId.clear();

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
      if (!this.isAuthorized(request)) {
        this.writeUnauthorized(response);
        return;
      }
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
        this.commandOwnersByInvocationId,
        this.options.createSessionId,
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
    this.options.onClientConnected?.(clientId);
    writeSse(response, { clientId, type: "hello" });

    request.on("close", () => {
      if (this.clients.delete(client)) {
        this.disconnectClient(clientId);
        this.options.onClientDisconnected?.(clientId);
      }
    });
  }

  private disconnectClient(clientId: string): void {
    this.options.permissionRouter.disconnectClient(clientId);
    for (const [invocationId, owner] of this.commandOwnersByInvocationId) {
      if (owner === clientId) {
        this.commandOwnersByInvocationId.delete(invocationId);
      }
    }
    for (const [runId, owner] of this.commandOwnersByRunId) {
      if (owner === clientId) {
        this.commandOwnersByRunId.delete(runId);
      }
    }
    for (const [runId, owner] of this.runOwnersByRunId) {
      if (owner === clientId) {
        this.runOwnersByRunId.delete(runId);
      }
    }
  }

  private broadcast(event: UiEvent): void {
    this.options.permissionRouter.observeEvent(event);
    this.updateClientViewsFromEvent(event);
    for (const client of Array.from(this.clients)) {
      const routed = this.routeEventForClient(event, client.clientId);
      if (!routed) {
        continue;
      }
      const filtered = this.options.permissionRouter.filterEventForClient(
        routed,
        client.clientId,
      );
      if (filtered) {
        writeSse(client.response, { event: filtered, type: "ui.event" });
      }
    }
    this.finalizeEventAfterBroadcast(event);
  }

  private updateClientViewsFromEvent(event: UiEvent): void {
    switch (event.type) {
      case "session.updated":
        return;
      case "command.started": {
        const owner = this.commandOwnersByInvocationId.get(
          event.command.clientInvocationId,
        );
        if (owner !== undefined) {
          this.commandOwnersByRunId.set(event.command.commandRunId, owner);
        }
        return;
      }
      case "command.result.delivered": {
        const owner = this.commandOwnerForEvent(event);
        const selectedSessionId = selectedSessionIdFromCommandAction(
          event.action,
        );
        if (owner !== undefined && selectedSessionId !== undefined) {
          this.setClientActiveSession(owner, selectedSessionId);
        }
        return;
      }
      case "command.failed":
        return;
      case "runtime.updated": {
        const runId =
          event.status.kind === "running" ? event.status.runId : undefined;
        if (runId !== undefined && this.activePrompt !== undefined) {
          this.runOwnersByRunId.set(runId, this.activePrompt.clientId);
          if (this.activePrompt.sessionId !== undefined) {
            this.runSessionIdsByRunId.set(runId, this.activePrompt.sessionId);
          }
        }
        return;
      }
      case "run.updated": {
        this.runSessionIdsByRunId.set(event.run.id, event.run.sessionId);
        if (
          this.activePrompt?.sessionId === event.run.sessionId ||
          (this.activePrompt?.sessionId === undefined &&
            this.activePrompt !== undefined)
        ) {
          this.runOwnersByRunId.set(event.run.id, this.activePrompt.clientId);
        }
        if (
          event.run.status.kind !== "running" &&
          event.run.status.kind !== "waiting-for-permission"
        ) {
          this.runOwnersByRunId.delete(event.run.id);
        }
        return;
      }
      default:
        return;
    }
  }

  private routeEventForClient(
    event: UiEvent,
    clientId: string,
  ): UiEvent | undefined {
    const view = this.clientViews.get(clientId);

    if (event.type === "snapshot.replaced") {
      return {
        ...event,
        snapshot: snapshotForClient(event.snapshot, view),
      };
    }

    if (event.type === "runtime.updated") {
      return this.runtimeEventBelongsToClient(event, clientId)
        ? event
        : undefined;
    }

    if (
      event.type === "command.started" ||
      event.type === "command.result.delivered" ||
      event.type === "command.failed"
    ) {
      return this.commandEventBelongsToClient(event, clientId) ? event : undefined;
    }

    if (
      event.type === "interaction.requested" ||
      event.type === "interaction.resolved"
    ) {
      return this.interactionEventBelongsToClient(event, clientId)
        ? event
        : undefined;
    }

    const sessionId = sessionIdForEvent(event);
    if (sessionId === undefined || view === undefined) {
      return event;
    }
    return view.activeSessionId === sessionId ? event : undefined;
  }

  private commandEventBelongsToClient(
    event: Extract<
      UiEvent,
      {
        type:
          | "command.started"
          | "command.result.delivered"
          | "command.failed";
      }
    >,
    clientId: string,
  ): boolean {
    const owner =
      event.type === "command.started"
        ? this.commandOwnersByInvocationId.get(event.command.clientInvocationId)
        : this.commandOwnerForEvent(event);
    return owner === clientId;
  }

  private runtimeEventBelongsToClient(
    event: Extract<UiEvent, { type: "runtime.updated" }>,
    clientId: string,
  ): boolean {
    const sessionId = this.runtimeEventSessionId(event);
    if (sessionId !== undefined) {
      return this.clientViews.get(clientId)?.activeSessionId === sessionId;
    }

    return this.runtimeEventOwner(event) === clientId;
  }

  private runtimeEventOwner(
    event: Extract<UiEvent, { type: "runtime.updated" }>,
  ): string | undefined {
    if (event.status.kind === "running") {
      return (
        this.runOwnersByRunId.get(event.status.runId) ??
        this.activePrompt?.clientId
      );
    }
    return this.activePrompt?.clientId;
  }

  private runtimeEventSessionId(
    event: Extract<UiEvent, { type: "runtime.updated" }>,
  ): string | undefined {
    if (event.status.kind === "running") {
      return (
        this.runSessionIdsByRunId.get(event.status.runId) ??
        this.activePrompt?.sessionId
      );
    }
    return this.activePrompt?.sessionId;
  }

  private interactionEventBelongsToClient(
    event: Extract<
      UiEvent,
      { type: "interaction.requested" | "interaction.resolved" }
    >,
    clientId: string,
  ): boolean {
    const clientInvocationId =
      event.type === "interaction.requested"
        ? event.request.clientInvocationId
        : event.clientInvocationId;
    const commandRunId =
      event.type === "interaction.requested"
        ? event.request.commandRunId
        : event.commandRunId;
    const owner =
      (clientInvocationId === undefined
        ? undefined
        : this.commandOwnersByInvocationId.get(clientInvocationId)) ??
      this.commandOwnersByRunId.get(commandRunId);
    return owner === undefined || owner === clientId;
  }

  private commandOwnerForEvent(
    event: Extract<
      UiEvent,
      { type: "command.result.delivered" | "command.failed" }
    >,
  ): string | undefined {
    return (
      this.commandOwnersByInvocationId.get(event.clientInvocationId) ??
      this.commandOwnersByRunId.get(event.commandRunId)
    );
  }

  private forgetCommandOwner(
    event: Extract<
      UiEvent,
      { type: "command.result.delivered" | "command.failed" }
    >,
  ): void {
    this.commandOwnersByInvocationId.delete(event.clientInvocationId);
    this.commandOwnersByRunId.delete(event.commandRunId);
  }

  private finalizeEventAfterBroadcast(event: UiEvent): void {
    if (event.type === "command.failed") {
      this.forgetCommandOwner(event);
    }
  }

  private setClientActiveSession(clientId: string, sessionId: string): void {
    const view = this.clientViews.get(clientId);
    if (view === undefined) {
      return;
    }
    view.activeSessionId = sessionId;
  }
}

export function createDaemonHttpServer(
  options: DaemonHttpServerOptions,
): DaemonHttpServerHandle {
  return new DaemonHttpServer({
    backend: options.backend,
    authToken: options.authToken,
    createSessionId: options.createSessionId ?? createSessionIdGenerator(),
    host: options.host ?? DEFAULT_HOST,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: options.onClientDisconnected,
    onShutdown: options.onShutdown,
    packageVersion: options.packageVersion,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
    promptQueue: options.promptQueue,
  });
}
