import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Hono, type Context } from "hono";
import {
  filterWebCommandCatalog,
  filterWebPassthroughCommandCatalog,
  inferConnectModelInterfaceProvider,
  supportsWebOverlayCommandInvocation,
  supportsWebPassthroughCommandInvocation,
  supportsWebSkillCommandInvocation,
  type UiBackendClient,
  type UiEvent,
  type UiPermissionResponse,
  type UiSlashCommandInvocation,
  type UiSnapshot,
  type UiUnsubscribe,
} from "ohbaby-sdk";
import { isAuthorizedDaemonRequest } from "../auth/token.js";
import {
  DaemonClientViewCoordinator,
  parseDaemonStartupIntent,
} from "../coordination/client-view.js";
import { EventBus, type EventEnvelope } from "../coordination/event-bus.js";
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
  type DaemonStartupIntent,
} from "../protocols/jsonrpc/protocol.js";

const encoder = new TextEncoder();
const DEFAULT_CLIENT_DISCONNECT_RETENTION_MS = 5_000;
const CLIENT_ID_HEADER = "x-ohbaby-client-id";

const DEFAULT_WEB_STARTUP_INTENT: DaemonStartupIntent = {
  startupSessionMode: { type: "fresh" },
};

interface WebAssetsOptions {
  readonly allowTokenInjection?: boolean;
  readonly baseUrl?: string;
  readonly directory: string;
}

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
  readonly webAssets?: WebAssetsOptions;
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

function webErrorBody(message: string): unknown {
  return { error: { message }, ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return undefined;
  }
  return value as number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutationErrorStatus(error: unknown): 400 | 404 | 409 {
  const message = errorMessage(error);
  if (message.startsWith("Session not found:")) {
    return 404;
  }
  return message === "Cannot save while running" ? 409 : 400;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length === value.length ? items : undefined;
}

function escapeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function permissionRouterSnapshotForClient(
  permissionRouter: PermissionRouter,
  snapshot: UiSnapshot,
  clientId: string,
): UiSnapshot {
  return permissionRouter.filterSnapshotForClient(snapshot, clientId);
}

function permissionResponseFromBody(
  value: Record<string, unknown>,
): UiPermissionResponse | undefined {
  const choiceId = asNonEmptyString(value.choiceId);
  if (!choiceId) {
    return undefined;
  }
  return {
    choiceId,
    ...(typeof value.remember === "boolean"
      ? { remember: value.remember }
      : {}),
  };
}

function slashCommandInvocationFromBody(
  value: Record<string, unknown>,
): UiSlashCommandInvocation | undefined {
  const clientInvocationId = asNonEmptyString(value.clientInvocationId);
  const commandId = asNonEmptyString(value.commandId);
  const path = asStringArray(value.path);
  const raw = typeof value.raw === "string" ? value.raw : undefined;
  const rawArgs = typeof value.rawArgs === "string" ? value.rawArgs : undefined;
  const argv = asStringArray(value.argv);
  const surface = asNonEmptyString(value.surface);
  if (
    clientInvocationId === undefined ||
    commandId === undefined ||
    path === undefined ||
    raw === undefined ||
    rawArgs === undefined ||
    argv === undefined ||
    surface === undefined
  ) {
    return undefined;
  }
  const body = typeof value.body === "string" ? value.body : undefined;
  const sessionId = asNonEmptyString(value.sessionId);
  const argumentMode =
    value.argumentMode === "raw" ||
    value.argumentMode === "argv" ||
    value.argumentMode === "structured"
      ? value.argumentMode
      : undefined;
  return {
    argv,
    commandId,
    clientInvocationId,
    path,
    raw,
    rawArgs,
    surface,
    ...(argumentMode === undefined ? {} : { argumentMode }),
    ...(body === undefined ? {} : { body }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function sessionCommandInvocation(
  command: "new" | "resume",
  sessionId?: string,
): UiSlashCommandInvocation {
  if (command === "new") {
    return {
      argumentMode: "argv",
      argv: [],
      clientInvocationId: `web_session_${randomUUID()}`,
      commandId: "new",
      path: ["new"],
      raw: "/new",
      rawArgs: "",
      surface: "tui",
    };
  }
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  return {
    argumentMode: "argv",
    argv: ["--session_id", sessionId],
    clientInvocationId: `web_session_${randomUUID()}`,
    commandId: "resume",
    path: ["resume"],
    raw: `/resume --session_id ${sessionId}`,
    rawArgs: `--session_id ${sessionId}`,
    surface: "tui",
  };
}

function modelConnectInputFromBody(
  value: Record<string, unknown>,
): Parameters<UiBackendClient["connectModel"]>[0] | undefined {
  const provider = asNonEmptyString(value.provider);
  const baseUrl = asNonEmptyString(value.baseUrl);
  const apiKeyEnv = asNonEmptyString(value.apiKeyEnv);
  const apiKey = asNonEmptyString(value.apiKey);
  const model = asNonEmptyString(value.model);
  const contextWindowTokens = asPositiveInteger(value.contextWindowTokens);
  const maxOutputTokens = asPositiveInteger(value.maxOutputTokens);
  if (
    provider === undefined ||
    baseUrl === undefined ||
    model === undefined ||
    (value.contextWindowTokens !== undefined &&
      contextWindowTokens === undefined) ||
    (value.maxOutputTokens !== undefined && maxOutputTokens === undefined)
  ) {
    return undefined;
  }
  return {
    provider,
    baseUrl,
    interfaceProvider: inferConnectModelInterfaceProvider(baseUrl),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKey === undefined ? {} : { apiKey }),
    model,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function searchApiKeyInputFromBody(
  value: Record<string, unknown>,
): Parameters<UiBackendClient["setSearchApiKey"]>[0] | undefined {
  const provider = asNonEmptyString(value.provider);
  const apiKeyEnv = asNonEmptyString(value.apiKeyEnv);
  const apiKey = asNonEmptyString(value.apiKey);
  if (provider !== undefined && provider !== "tavily") {
    return undefined;
  }
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(provider === undefined ? {} : { provider }),
  };
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

function parseLastEventId(value: string | undefined): LastEventIdParseResult {
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

async function readJsonWithLimit(request: Request): Promise<
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly message: string;
      readonly ok: false;
      readonly status: number;
    }
> {
  const body = await readRequestTextWithLimit(request);
  if (!body.ok) {
    return {
      message: "Request body is too large",
      ok: false,
      status: 413,
    };
  }
  if (body.body.trim().length === 0) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(body.body) as unknown };
  } catch {
    return {
      message: "Request body must be valid JSON",
      ok: false,
      status: 400,
    };
  }
}

function createOpenApiDocument(packageVersion: string | undefined): unknown {
  return {
    info: {
      title: "ohbaby local daemon API",
      version: packageVersion ?? "0.1.6-dev",
    },
    openapi: "3.1.0",
    paths: {
      "/v1/clients": {
        post: {
          responses: {
            "200": {
              description: "Registered browser client",
            },
          },
          summary: "Register a browser client view",
        },
      },
      "/v1/events": {
        get: {
          responses: {
            "200": {
              description: "SSE stream of daemon events",
            },
          },
          summary: "Subscribe to replayable event stream",
        },
      },
      "/v1/commands": {
        get: {
          responses: {
            "200": {
              description: "Slash command catalog",
            },
          },
          summary: "List slash commands for a browser client",
        },
        post: {
          responses: {
            "200": {
              description: "Command invocation accepted",
            },
          },
          summary: "Execute a slash command invocation",
        },
      },
      "/v1/model": {
        get: {
          responses: {
            "200": {
              description: "Current model config without secret values",
            },
          },
          summary: "Get current model config",
        },
        post: {
          responses: {
            "200": {
              description: "Model config saved",
            },
            "409": {
              description: "Prompt run is active",
            },
          },
          summary: "Save current model config",
        },
      },
      "/v1/model/context-window-probe": {
        post: {
          responses: {
            "200": {
              description: "Context window probe result",
            },
          },
          summary: "Probe model context window without saving config",
        },
      },
      "/v1/permissions/{id}": {
        post: {
          responses: {
            "200": {
              description: "Permission response accepted",
            },
            "403": {
              description: "Permission belongs to another client",
            },
          },
          summary: "Respond to a permission request",
        },
      },
      "/v1/permission": {
        patch: {
          responses: {
            "200": {
              description: "Permission state updated",
            },
          },
          summary: "Update daemon permission state",
        },
      },
      "/v1/prompts": {
        post: {
          responses: {
            "202": {
              description: "Prompt accepted for asynchronous execution",
            },
          },
          summary: "Submit a prompt",
        },
      },
      "/v1/sessions": {
        post: {
          responses: {
            "200": {
              description: "Session creation command accepted",
            },
          },
          summary: "Create a new session",
        },
      },
      "/v1/settings/search-api-key": {
        post: {
          responses: {
            "200": {
              description: "Search API key settings saved",
            },
            "409": {
              description: "Prompt run is active",
            },
          },
          summary: "Save search API key settings",
        },
      },
      "/v1/sessions/{id}/abort": {
        post: {
          responses: {
            "200": {
              description: "Abort request accepted",
            },
          },
          summary: "Abort a session run",
        },
      },
      "/v1/sessions/{id}/compact": {
        post: {
          responses: {
            "200": {
              description: "Session compact result",
            },
          },
          summary: "Compact a session",
        },
      },
      "/v1/sessions/{id}/select": {
        patch: {
          responses: {
            "200": {
              description: "Session selection command accepted",
            },
          },
          summary: "Select a session",
        },
      },
      "/v1/sessions/{id}/archive": {
        patch: {
          responses: {
            "200": {
              description: "Session archived",
            },
            "404": {
              description: "Session not found",
            },
          },
          summary: "Archive a session",
        },
      },
      "/v1/sessions/{id}/context-window": {
        get: {
          responses: {
            "200": {
              description: "Session context window usage",
            },
          },
          summary: "Get session context window usage",
        },
      },
      "/v1/snapshot": {
        get: {
          responses: {
            "200": {
              description: "Client snapshot with event sequence baseline",
            },
          },
          summary: "Get current projected snapshot",
        },
      },
    },
  };
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
  private readonly replayEventsBySeqNum = new Map<
    number,
    Map<string, UiEvent>
  >();
  private readonly registeredWebClientIds = new Set<string>();
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
    this.registeredWebClientIds.clear();
    this.clientViews.resetRuntimeState();
    this.replayEventsBySeqNum.clear();
    this.started = false;
  }

  private mountRoutes(): void {
    this.app.get("/doc", (context) => {
      return context.json(createOpenApiDocument(this.options.packageVersion));
    });

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

    this.app.post("/v1/clients", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const clientId =
        asNonEmptyString(body.clientId) ??
        asNonEmptyString(context.req.header(CLIENT_ID_HEADER)) ??
        randomUUID();
      const startupIntent = parseDaemonStartupIntent(
        body.startupIntent ?? DEFAULT_WEB_STARTUP_INTENT,
      );
      const snapshot = await this.options.backend.getSnapshot();
      this.clientViews.initializeClient(clientId, snapshot, startupIntent);
      this.knownClientIds.add(clientId);
      this.registeredWebClientIds.add(clientId);
      this.cancelClientRoutingCleanup(clientId);

      return context.json({ clientId, ok: true });
    });

    this.app.get("/v1/snapshot", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const snapshot = await this.options.backend.getSnapshot();
      const seqNum = this.eventBus.latestSeqNum;
      return context.json({
        ok: true,
        seqNum,
        snapshot: permissionRouterSnapshotForClient(
          this.permissionRouter,
          this.clientViews.projectSnapshot(clientId, snapshot),
          clientId,
        ),
      });
    });

    this.app.get("/v1/events", (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }
      return this.createSseResponse(
        clientId,
        context.req.raw.signal,
        context.req.header("last-event-id"),
      );
    });

    this.app.get("/v1/commands", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const surface = asNonEmptyString(context.req.query("surface")) ?? "tui";
      const backendSurface = surface === "web" ? "tui" : surface;
      const backendCatalog = await this.options.backend.listCommands({
        surface: backendSurface,
      });
      const catalog =
        surface === "web"
          ? filterWebCommandCatalog(backendCatalog, { surface: backendSurface })
          : filterWebPassthroughCommandCatalog(backendCatalog, {
              surface: backendSurface,
            });
      return context.json({ catalog, ok: true });
    });

    this.app.post("/v1/commands", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const invocation = slashCommandInvocationFromBody(body);
      if (invocation === undefined) {
        return context.json(webErrorBody("command invocation is invalid"), 400);
      }
      const catalog = await this.options.backend.listCommands({
        surface: invocation.surface,
      });
      if (
        !supportsWebPassthroughCommandInvocation(catalog, invocation) &&
        !supportsWebOverlayCommandInvocation(catalog, invocation) &&
        !supportsWebSkillCommandInvocation(catalog, invocation)
      ) {
        return context.json(
          webErrorBody("command is not supported by web passthrough"),
          400,
        );
      }

      await this.options.backend.executeCommand(
        this.clientViews.prepareCommandInvocation(clientId, invocation),
      );
      return context.json({ ok: true });
    });

    this.app.get("/v1/model", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const model = await this.options.backend.getCurrentModel();
      return context.json({ model, ok: true });
    });

    this.app.post("/v1/model/context-window-probe", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const input = modelConnectInputFromBody(body);
      if (input === undefined) {
        return context.json(
          webErrorBody("model connection body is invalid"),
          400,
        );
      }
      try {
        const probe = await this.options.backend.probeModelContextWindow(input);
        return context.json({ ok: true, probe });
      } catch (error) {
        return context.json(webErrorBody(errorMessage(error)), 400);
      }
    });

    this.app.post("/v1/model", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const input = modelConnectInputFromBody(body);
      if (input === undefined) {
        return context.json(
          webErrorBody("model connection body is invalid"),
          400,
        );
      }
      try {
        const model = await this.options.backend.connectModel(input);
        return context.json({ model, ok: true });
      } catch (error) {
        return context.json(
          webErrorBody(errorMessage(error)),
          mutationErrorStatus(error),
        );
      }
    });

    this.app.post("/v1/settings/search-api-key", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const input = searchApiKeyInputFromBody(body);
      if (input === undefined) {
        return context.json(
          webErrorBody("search api key body is invalid"),
          400,
        );
      }
      try {
        const search = await this.options.backend.setSearchApiKey(input);
        return context.json({ ok: true, search });
      } catch (error) {
        return context.json(
          webErrorBody(errorMessage(error)),
          mutationErrorStatus(error),
        );
      }
    });

    this.app.post("/v1/sessions", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      await this.options.backend.executeCommand(
        this.clientViews.prepareCommandInvocation(
          clientId,
          sessionCommandInvocation("new"),
        ),
      );
      return context.json({ ok: true });
    });

    this.app.patch("/v1/sessions/:id/select", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }
      const sessionId = asNonEmptyString(context.req.param("id"));
      if (!sessionId) {
        return context.json(webErrorBody("sessionId is required"), 400);
      }

      await this.options.backend.executeCommand(
        this.clientViews.prepareCommandInvocation(
          clientId,
          sessionCommandInvocation("resume", sessionId),
        ),
      );
      return context.json({ ok: true });
    });

    this.app.patch("/v1/sessions/:id/archive", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }
      const sessionId = asNonEmptyString(context.req.param("id"));
      if (!sessionId) {
        return context.json(webErrorBody("sessionId is required"), 400);
      }

      try {
        await this.options.backend.archiveSession({ sessionId });
        return context.json({ ok: true });
      } catch (error) {
        return context.json(
          webErrorBody(errorMessage(error)),
          mutationErrorStatus(error),
        );
      }
    });

    this.app.get("/v1/sessions/:id/context-window", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const usage = await this.options.backend.getContextWindowUsage({
        sessionId: context.req.param("id"),
      });
      return context.json({ ok: true, usage });
    });

    this.app.post("/v1/sessions/:id/compact", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const force = typeof body.force === "boolean" ? body.force : undefined;
      try {
        const compact = await this.options.backend.compactSession({
          ...(force === undefined ? {} : { force }),
          sessionId: context.req.param("id"),
        });
        return context.json({ compact, ok: true });
      } catch (error) {
        return context.json(webErrorBody(errorMessage(error)), 400);
      }
    });

    this.app.post("/v1/prompts", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const text = asNonEmptyString(body.text);
      if (!text) {
        return context.json(webErrorBody("text is required"), 400);
      }
      const sessionId = asNonEmptyString(body.sessionId);
      const prepared = this.clientViews.preparePromptSubmit(
        clientId,
        sessionId === undefined ? undefined : { sessionId },
        this.createSessionId,
      );
      void this.promptQueue
        .enqueue({
          clientId,
          ...(prepared.options === undefined
            ? {}
            : { options: prepared.options }),
          ...(prepared.sessionId === undefined
            ? {}
            : { sessionId: prepared.sessionId }),
          text,
        })
        .catch((error: unknown) => {
          this.writeErrorToClient(
            clientId,
            error instanceof Error ? error.message : String(error),
          );
        });

      return context.json(
        {
          ok: true,
          ...(prepared.sessionId === undefined
            ? {}
            : { sessionId: prepared.sessionId }),
        },
        202,
      );
    });

    this.app.patch("/v1/permission", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const mode = body.mode;
      const level = body.level;
      if (mode !== undefined && mode !== "auto" && mode !== "plan") {
        return context.json(webErrorBody("mode must be auto or plan"), 400);
      }
      if (
        level !== undefined &&
        level !== "default" &&
        level !== "full-access"
      ) {
        return context.json(
          webErrorBody("level must be default or full-access"),
          400,
        );
      }
      if (mode === undefined && level === undefined) {
        return context.json(webErrorBody("mode or level is required"), 400);
      }

      const permission = await this.options.backend.setPermission({
        ...(level === undefined ? {} : { level }),
        ...(mode === undefined ? {} : { mode }),
      });
      return context.json({ ok: true, permission });
    });

    this.app.post("/v1/permissions/:id", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }
      const requestId = context.req.param("id");
      if (!this.permissionRouter.canRespondPermission(requestId, clientId)) {
        return context.json(
          webErrorBody("Permission request is owned by another client"),
          403,
        );
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const responseValue = isRecord(body.response) ? body.response : body;
      const response = permissionResponseFromBody(responseValue);
      if (!response) {
        return context.json(webErrorBody("choiceId is required"), 400);
      }
      await this.options.backend.respondPermission(requestId, response);
      return context.json({ ok: true });
    });

    this.app.post("/v1/sessions/:id/abort", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(webErrorBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(webErrorBody("client is not registered"), 409);
      }
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const runId = await this.runIdForAbort(
        context.req.param("id"),
        asNonEmptyString(body.runId),
      );
      if (runId === undefined) {
        return context.json(webErrorBody("No running run for session"), 404);
      }
      await this.options.backend.abortRun(runId);
      return context.json({ ok: true });
    });

    this.app.get("/", (context) => this.serveWebAsset(context));
    this.app.get("/*", (context) => this.serveWebAsset(context));
  }

  private isAuthorized(authorization: string | undefined): boolean {
    return isAuthorized(authorization, this.authToken);
  }

  private isRegisteredWebClient(clientId: string): boolean {
    return this.registeredWebClientIds.has(clientId);
  }

  private clientIdFromRequest(context: {
    readonly req: {
      header(name: string): string | undefined;
      query(name: string): string | undefined;
    };
  }): string | undefined {
    return (
      asNonEmptyString(context.req.header(CLIENT_ID_HEADER)) ??
      asNonEmptyString(context.req.query("clientId"))
    );
  }

  private async runIdForAbort(
    sessionId: string,
    requestedRunId: string | undefined,
  ): Promise<string | undefined> {
    const snapshot = await this.options.backend.getSnapshot();
    if (requestedRunId !== undefined) {
      const requestedRun = snapshot.runs.find(
        (candidate) => candidate.id === requestedRunId,
      );
      return requestedRun?.sessionId === sessionId
        ? requestedRun.id
        : undefined;
    }
    const run = snapshot.runs.find((candidate) => {
      if (candidate.sessionId !== sessionId) {
        return false;
      }
      return (
        candidate.status.kind === "running" ||
        candidate.status.kind === "waiting-for-permission"
      );
    });
    if (run) {
      return run.id;
    }
    const status = snapshot.status;
    if (status.kind === "running") {
      const activeRun = snapshot.runs.find(
        (candidate) => candidate.id === status.runId,
      );
      return activeRun?.sessionId === sessionId ? activeRun.id : undefined;
    }
    if (status.kind === "waiting-for-permission") {
      const permission = snapshot.permissions.find(
        (candidate) => candidate.id === status.requestId,
      );
      const activeRun =
        permission === undefined
          ? undefined
          : snapshot.runs.find(
              (candidate) => candidate.id === permission.runId,
            );
      return activeRun?.sessionId === sessionId ? activeRun.id : undefined;
    }
    return undefined;
  }

  private async serveWebAsset(context: Context): Promise<Response> {
    const webAssets = this.options.webAssets;
    if (!webAssets) {
      return new Response("Not Found", { status: 404 });
    }
    if (webAssets.allowTokenInjection === false) {
      return new Response("Web assets require a loopback host", {
        status: 403,
      });
    }

    const pathname = new URL(context.req.raw.url).pathname;
    if (
      pathname.startsWith("/api/") ||
      pathname.startsWith("/v1/") ||
      pathname === "/doc"
    ) {
      return new Response("Not Found", { status: 404 });
    }

    const root = resolve(webAssets.directory);
    const relativePath =
      pathname === "/"
        ? "index.html"
        : decodeURIComponent(pathname.replace(/^\/+/, ""));
    if (relativePath.includes("\0")) {
      return new Response("Bad Request", { status: 400 });
    }

    let filePath = resolve(root, relativePath);
    const pathRelation = relative(root, filePath);
    if (pathRelation.startsWith("..") || isAbsolute(pathRelation)) {
      return new Response("Forbidden", { status: 403 });
    }

    let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      fileStat = await stat(filePath);
    } catch {
      const acceptsHtml = context.req.header("accept")?.includes("text/html");
      if (!acceptsHtml || extname(filePath).length > 0) {
        return new Response("Not Found", { status: 404 });
      }
      filePath = resolve(root, "index.html");
      fileStat = await stat(filePath);
    }
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }

    let body = await readFile(filePath);
    const contentType = contentTypeForPath(filePath);
    if (contentType.startsWith("text/html")) {
      const bootstrap = {
        baseUrl: webAssets.baseUrl ?? "",
        clientId: randomUUID(),
        startupIntent: DEFAULT_WEB_STARTUP_INTENT,
        token: this.authToken,
      };
      const html = body
        .toString("utf8")
        .replace(
          "</head>",
          `<script>window.__OHBABY__=${escapeInlineScriptJson(
            bootstrap,
          )};</script></head>`,
        );
      body = Buffer.from(html, "utf8");
    }

    return new Response(body, {
      headers: {
        "cache-control": contentType.startsWith("text/html")
          ? "no-store"
          : "public, max-age=31536000, immutable",
        "content-type": contentType,
      },
      status: 200,
    });
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
      this.knownClientIds.delete(clientId);
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

  private writeErrorToClient(clientId: string, message: string): void {
    for (const client of Array.from(this.clients)) {
      if (client.clientId === clientId) {
        client.write({ message, type: "error" });
      }
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
