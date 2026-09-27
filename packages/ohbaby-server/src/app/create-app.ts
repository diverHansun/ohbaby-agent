import {
  createOrReuseClientSession,
  abortForClient,
  parseSessionQuery,
  parseSessionCreationOptions,
  receiptForClient,
  sessionReadForClient,
  sessionRecoveryCapability,
} from "../coordination/session-access.js";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Hono, type Context } from "hono";
import {
  filterWebCommandCatalog,
  filterWebPassthroughCommandCatalog,
  inferConnectModelInterfaceProvider,
  isConnectModelInterfaceProvider,
  isUiReasoningConfig,
  UI_REASONING_STATUSES,
  supportsWebOverlayCommandInvocation,
  supportsWebPassthroughCommandInvocation,
  supportsWebSkillCommandInvocation,
  type UiBackendClient,
  type UiCancelQueuedPromptInput,
  type UiEditQueuedPromptInput,
  type UiEvent,
  type UiReleasePromptEditLeaseInput,
  type UiPermissionResponse,
  type UiSlashCommandInvocation,
  type UiSnapshot,
  type UiUnsubscribe,
  type UiCommandCorrelation,
  type UiCommandRecorder,
} from "ohbaby-sdk";
import {
  createUiCommandGateway,
  interactionCleanupFailure,
  NOOP_LOGGER,
  type Logger,
  type UiPromptQueueExecutionPort,
} from "ohbaby-agent";
import { emitDiagnosticSafely } from "../observability/emit.js";
import { isAuthorizedDaemonRequest } from "../auth/token.js";
import {
  DaemonClientViewCoordinator,
  parseDaemonStartupIntent,
  respondInteractionForClient,
} from "../coordination/client-view.js";
import { EventBus, type EventEnvelope } from "../coordination/event-bus.js";
import {
  PermissionRouter,
  isPermissionEvent,
} from "../coordination/permission-router.js";
import {
  initializePermissionClient,
  parsePermissionBinding,
  permissionSnapshotForClient,
  respondPermissionForClient,
  selectPermissionSession,
} from "../coordination/permission-access.js";
import {
  acquirePromptEditLeaseForClient,
  acceptDaemonPrompt,
  cancelQueuedPromptForClient,
  editQueuedPromptForClient,
  releasePromptEditLeaseForClient,
  renewPromptEditLeaseForClient,
} from "../coordination/prompt-backend.js";
import {
  callDaemonBackend,
  createDaemonRpcSuccessResponse,
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
  readonly workspaceDirectory?: string;
}

interface SseClient {
  readonly clientId: string;
  close(): void;
  write(event: DaemonSseEvent, id?: number): void;
}

export interface DaemonServerAppOptions {
  readonly backend: UiBackendClient & UiPromptQueueExecutionPort;
  readonly authToken?: string;
  readonly clientDisconnectRetentionMs?: number;
  readonly commandRecorder?: UiCommandRecorder | false;
  readonly createSessionId?: () => string;
  readonly eventBufferCapacity?: number;
  readonly logger?: Logger;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly permissionRouter?: PermissionRouter;
  readonly webAssets?: WebAssetsOptions;
}

const NOOP_COMMAND_RECORDER: UiCommandRecorder = {
  record(): void {
    return;
  },
};

function reportInteractionCleanupFailure(logger: Logger, error: unknown): void {
  emitDiagnosticSafely(logger, interactionCleanupFailure, {
    error,
    operation: "disconnect",
  });
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

function promptRejectionBody(message: string): unknown {
  return { error: { code: "PROMPT_SUBMISSION_REJECTED", message }, ok: false };
}

/** An unclassified admission error can occur after the durable receipt was saved. */
function promptAdmissionStatus(error: unknown): 400 | 409 | 429 | 500 {
  const code = isRecord(error) ? error.code : undefined;
  if (code === "QUEUE_FULL") return 429;
  if (code === "IDEMPOTENCY_CONFLICT") return 409;
  if (
    code === "PROMPT_SUBMISSION_REJECTED" ||
    code === "INVALID_CLIENT_REQUEST_ID" ||
    code === "PROMPT_SCHEDULER_CLOSED"
  )
    return 400;
  return 500;
}

function promptErrorBody(error: unknown): unknown {
  const serialized = createDaemonRpcFailure("http", error);
  if (serialized.ok) {
    throw new Error("Expected serialized prompt failure");
  }
  return {
    error: {
      ...serialized.error,
      code:
        serialized.error.code ??
        (error instanceof Error ? error.name : "PROMPT_ERROR"),
    },
    ok: false,
  };
}

function promptMutationStatus(error: unknown): 400 | 404 | 409 | 429 {
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "QUEUE_FULL") {
    return 429;
  }
  if (code === "PROMPT_NOT_FOUND") {
    return 404;
  }
  if (
    code === "PROMPT_NOT_QUEUED" ||
    code === "PROMPT_VERSION_CONFLICT" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "PROMPT_EDIT_LEASE_HELD" ||
    code === "PROMPT_EDIT_LEASE_LOST" ||
    code === "INVALID_PROMPT_TRANSITION"
  ) {
    return 409;
  }
  return 400;
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
  rootSessionId: string | null,
): UiSnapshot {
  return permissionRouter.filterSnapshotForClient(snapshot, rootSessionId);
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
    (Object.hasOwn(value, "interfaceProvider") &&
      !isConnectModelInterfaceProvider(value.interfaceProvider)) ||
    (value.contextWindowTokens !== undefined &&
      contextWindowTokens === undefined) ||
    (value.maxOutputTokens !== undefined && maxOutputTokens === undefined)
  ) {
    return undefined;
  }
  return {
    provider,
    baseUrl,
    interfaceProvider: isConnectModelInterfaceProvider(value.interfaceProvider)
      ? value.interfaceProvider
      : inferConnectModelInterfaceProvider(baseUrl),
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
  const recoveryParameters = [
    {
      name: "x-ohbaby-client-id",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "runtimeEpoch",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "bindingGeneration",
      in: "query",
      required: true,
      schema: { type: "integer", minimum: 1 },
    },
  ];
  const recoveryResponses = {
    "200": {
      description:
        "Source-owned data with its original session version and current binding",
    },
    "400": { description: "Invalid query or cursor" },
    "409": { description: "Session binding changed or scope is unavailable" },
    "426": { description: "Session recovery capability is unsupported" },
    "503": { description: "Source projection or control is unavailable" },
  };

  return {
    info: {
      title: "ohbaby local daemon API",
      version: packageVersion ?? "0.1.12-dev",
    },
    openapi: "3.1.0",
    components: {
      schemas: {
        SessionVersion: {
          type: "object",
          required: [
            "runtimeEpoch",
            "sessionId",
            "viewGeneration",
            "sessionRevision",
          ],
          properties: {
            runtimeEpoch: { type: "string" },
            sessionId: { type: "string" },
            viewGeneration: { type: "string" },
            sessionRevision: { type: "integer", minimum: 0 },
          },
        },
        RecoveryBinding: {
          type: "object",
          required: [
            "runtimeEpoch",
            "permissionEpoch",
            "bindingGeneration",
            "rootSessionId",
            "sessionRecoveryVersion",
          ],
          properties: {
            runtimeEpoch: {
              type: "string",
              description: "Identical to permissionEpoch in this runtime",
            },
            permissionEpoch: { type: "string" },
            bindingGeneration: { type: "integer", minimum: 1 },
            rootSessionId: { type: ["string", "null"] },
            sessionRecoveryVersion: { type: "integer", enum: [0, 1] },
          },
        },

        ReasoningConfig: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            effort: { type: "string", minLength: 1 },
          },
        },
        ReasoningCapabilityView: {
          type: "object",
          required: ["status", "efforts"],
          properties: {
            status: { type: "string", enum: UI_REASONING_STATUSES },
            mode: { type: "string", enum: ["none", "binary", "effort"] },
            supportsDisabled: { type: "boolean" },
            efforts: { type: "array", items: { type: "string" } },
            default: { $ref: "#/components/schemas/ReasoningConfig" },
            source: { type: "string" },
            reason: { type: "string" },
            stale: { type: "boolean" },
          },
        },
      },
    },
    paths: {
      ...Object.fromEntries(
        ["view", "history", "control"].map((kind) => [
          `/v1/sessions/{id}/${kind}`,
          {
            get: {
              summary: `Read source session ${kind}`,
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                ...recoveryParameters,
                ...(kind === "history"
                  ? [
                      {
                        name: "before",
                        in: "query",
                        schema: { type: "string", maxLength: 4096 },
                      },
                      {
                        name: "limit",
                        in: "query",
                        schema: {
                          type: "integer",
                          minimum: 1,
                          maximum: 200,
                          default: 50,
                        },
                      },
                    ]
                  : []),
              ],
              responses: recoveryResponses,
            },
          },
        ]),
      ),
      "/v1/prompts/receipt": {
        get: {
          summary: "Recover the original prompt receipt without resubmitting",
          parameters: [
            ...recoveryParameters,
            {
              name: "clientRequestId",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            { name: "sessionId", in: "query", schema: { type: "string" } },
          ],
          responses: recoveryResponses,
        },
      },

      "/v1/sessions/{id}/reasoning": {
        patch: {
          summary: "Save session reasoning preference",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["reasoning"],
                  properties: {
                    reasoning: {
                      anyOf: [
                        { $ref: "#/components/schemas/ReasoningConfig" },
                        { type: "null" },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Session preference saved" },
            "400": { description: "Invalid preference" },
          },
        },
      },
      "/v1/clients": {
        post: {
          responses: {
            "200": {
              description: "Registered browser client",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RecoveryBinding" },
                },
              },
            },
          },
          summary: "Register a browser client view",
        },
      },
      "/v1/events": {
        get: {
          responses: {
            "200": {
              description:
                "SSE hello includes RecoveryBinding; session.changed carries the unchanged SessionVersion. Every revision for the selected root is delivered, including history-only invalidations. Transport sequence numbers are replay positions only.",
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
      "/v1/prompts/{id}": {
        delete: {
          responses: {
            "200": { description: "Queued prompt cancelled" },
            "409": { description: "Prompt is no longer queued" },
          },
          summary: "Cancel a queued prompt",
        },
        patch: {
          responses: {
            "200": { description: "Queued prompt edited" },
            "409": { description: "Prompt is no longer queued" },
          },
          summary: "Edit a queued prompt",
        },
      },
      "/v1/prompts/{id}/completion": {
        get: {
          responses: {
            "200": { description: "Prompt terminal completion" },
            "403": { description: "Prompt is unavailable to this client" },
          },
          summary: "Wait for a prompt to reach a terminal state",
        },
      },
      "/v1/interactions/{id}/respond": {
        post: {
          responses: {
            "200": { description: "Interaction response accepted" },
            "403": {
              description: "Interaction is unavailable to this client",
            },
          },
          summary: "Respond to an interaction owned by a browser client",
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
          summary:
            "Abort the exact active run from independent session control",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["runId", "runtimeEpoch", "bindingGeneration"],
                  properties: {
                    runId: { type: "string", minLength: 1 },
                    runtimeEpoch: { type: "string" },
                    bindingGeneration: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
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
  private readonly commandRecorder: UiCommandRecorder;
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
  private readonly replayEventsBySeqNum = new Map<
    number,
    Map<string, UiEvent>
  >();
  private readonly registeredWebClientIds = new Set<string>();
  private readonly waitControllers = new Set<AbortController>();
  private started = false;
  private unsubscribe: UiUnsubscribe | undefined;
  private unsubscribePermissions: UiUnsubscribe | undefined;
  private permissionEpoch = "";

  constructor(private readonly options: DaemonServerAppOptions) {
    this.authToken = requireAuthToken(options.authToken);
    this.clientDisconnectRetentionMs = normalizeClientDisconnectRetentionMs(
      options.clientDisconnectRetentionMs,
    );
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.commandRecorder =
      options.commandRecorder === undefined || options.commandRecorder === false
        ? NOOP_COMMAND_RECORDER
        : options.commandRecorder;
    this.eventBus =
      options.eventBufferCapacity === undefined
        ? new EventBus()
        : new EventBus({ capacity: options.eventBufferCapacity });
    this.permissionRouter = options.permissionRouter ?? new PermissionRouter();
    this.mountRoutes();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.unsubscribe = this.options.backend.subscribeEvents((event) => {
      if (isPermissionEvent(event)) return;
      const envelope = this.eventBus.publish(event);
      this.broadcast(envelope);
    });
    this.started = true;
    try {
      await this.options.backend.getSessionIndex();
      this.permissionEpoch = (
        await this.options.backend.getPermissionSnapshot({
          rootSessionId: null,
        })
      ).permissionEpoch;
      this.subscribePermissionForwarder();
    } catch (error) {
      this.unsubscribe();
      this.unsubscribe = undefined;
      this.started = false;
      throw error;
    }
  }

  private subscribePermissionForwarder(): void {
    this.unsubscribePermissions =
      this.options.backend.subscribePermissionEvents(
        (event) => {
          this.broadcastPermission(event);
        },
        () => {
          for (const client of [...this.clients]) this.disconnectClient(client);
          this.unsubscribePermissions?.();
          this.unsubscribePermissions = undefined;
          // Reinstall after the backend has detached the failed listener.
          queueMicrotask(() => {
            if (!this.started || this.unsubscribePermissions) return;
            try {
              this.subscribePermissionForwarder();
            } catch {
              // An unhealthy backend will reject permission queries until restart.
            }
          });
        },
      );
  }

  // Preserve rejected-Promise semantics if any synchronous cleanup step throws.
  // eslint-disable-next-line @typescript-eslint/require-await
  async dispose(): Promise<void> {
    for (const controller of this.waitControllers) controller.abort();
    this.waitControllers.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribePermissions?.();
    this.unsubscribePermissions = undefined;

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

  private commandBackend(
    entryPoint: "server-rest" | "server-rpc",
    correlation: UiCommandCorrelation,
  ): UiBackendClient & UiPromptQueueExecutionPort {
    return createUiCommandGateway(this.options.backend, {
      correlation,
      entryPoint,
      recorder: this.commandRecorder,
    });
  }

  private async waitForPrompt(
    backend: UiBackendClient,
    promptId: string,
    requestSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<UiBackendClient["waitForPrompt"]>>> {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    if (requestSignal.aborted) controller.abort();
    requestSignal.addEventListener("abort", abort, { once: true });
    this.waitControllers.add(controller);
    try {
      return await backend.waitForPrompt(promptId, {
        signal: controller.signal,
      });
    } finally {
      requestSignal.removeEventListener("abort", abort);
      this.waitControllers.delete(controller);
    }
  }

  private mountRoutes(): void {
    this.app.use("/v1/*", async (context, next) => {
      const clientId = this.clientIdFromRequest(context);
      if (
        clientId &&
        !context.req.raw.signal.aborted &&
        this.isAuthorized(context.req.header("authorization")) &&
        this.clientViews.isRegistered(clientId)
      )
        this.touchClientActivity(clientId);
      await next();
    });
    this.app.onError((error, context) => {
      const code =
        isRecord(error) && typeof error.code === "string"
          ? error.code
          : undefined;
      return context.json(
        {
          ok: false,
          error: { message: errorMessage(error), ...(code ? { code } : {}) },
        },
        code === "INVALID_SESSION_QUERY"
          ? 400
          : code === "SESSION_RECOVERY_UNSUPPORTED"
            ? 426
            : code === "SESSION_VIEW_UNAVAILABLE" ||
                code === "SESSION_CONTROL_UNAVAILABLE"
              ? 503
              : code === "SESSION_SCOPE_CHANGED" ||
                  code === "SESSION_CREATION_CONFLICT"
                ? 409
                : code === "INVALID_PERMISSION_CHOICE"
                  ? 400
                  : code === "PERMISSION_UNAVAILABLE"
                    ? 503
                    : code?.startsWith("PERMISSION_")
                      ? 409
                      : isDaemonForbiddenError(error)
                        ? 403
                        : 500,
      );
    });
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

      if (
        !context.req.raw.signal.aborted &&
        this.clientViews.isRegistered(parsed.request.clientId)
      )
        this.touchClientActivity(parsed.request.clientId);
      try {
        const controller = new AbortController();
        const abort = (): void => {
          controller.abort();
        };
        if (context.req.raw.signal.aborted) controller.abort();
        context.req.raw.signal.addEventListener("abort", abort, { once: true });
        this.waitControllers.add(controller);
        const priorGeneration = this.clientViews.isRegistered(
          parsed.request.clientId,
        )
          ? this.clientViews.binding(
              parsed.request.clientId,
              this.permissionEpoch,
            ).bindingGeneration
          : undefined;
        try {
          const result = await callDaemonBackend({
            backend: this.commandBackend("server-rpc", {
              clientId: parsed.request.clientId,
              transportRequestId: parsed.request.id,
            }),
            clientViews: this.clientViews,
            createSessionId: this.createSessionId,
            permissionRouter: this.permissionRouter,
            permissionEpoch: this.permissionEpoch,
            emitCommandEvent: (event) => {
              this.broadcast(this.eventBus.publish(event));
            },
            request: parsed.request,
            signal: controller.signal,
          });
          if (parsed.request.method === "initializeClient") {
            this.knownClientIds.add(parsed.request.clientId);
            this.registeredWebClientIds.add(parsed.request.clientId);
            this.touchClientActivity(parsed.request.clientId);
          }
          return context.json(
            createDaemonRpcSuccessResponse(parsed.request, result),
          );
        } finally {
          if (
            this.clientViews.isRegistered(parsed.request.clientId) &&
            !this.clientViews.isPromptBindingProvisional(
              parsed.request.clientId,
            ) &&
            this.clientViews.binding(
              parsed.request.clientId,
              this.permissionEpoch,
            ).bindingGeneration !== priorGeneration &&
            parsed.request.method !== "initializeClient"
          )
            this.notifyBinding(parsed.request.clientId);
          context.req.raw.signal.removeEventListener("abort", abort);
          this.waitControllers.delete(controller);
        }
      } catch (error) {
        const status =
          isRecord(error) && error.code === "SESSION_SCOPE_CHANGED"
            ? 409
            : isRecord(error) && error.code === "SESSION_RECOVERY_UNSUPPORTED"
              ? 426
              : isRecord(error) && error.code === "INVALID_SESSION_QUERY"
                ? 400
                : isDaemonForbiddenError(error)
                  ? 403
                  : isRecord(error) &&
                      error.code === "INVALID_CLIENT_REQUEST_ID"
                    ? 400
                    : 500;
        return context.json(
          createDaemonRpcFailure(parsed.request.id, error),
          status,
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
      if (!this.clientViews.isRegistered(clientId))
        return context.json(webErrorBody("client is not registered"), 409);
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
      const binding = await initializePermissionClient(
        this.options.backend,
        this.clientViews,
        clientId,
        startupIntent,
        this.permissionEpoch,
      );
      this.knownClientIds.add(clientId);
      this.registeredWebClientIds.add(clientId);
      this.touchClientActivity(clientId);

      return context.json({
        clientId,
        ok: true,
        ...binding,
        ...sessionRecoveryCapability(
          this.options.backend,
          this.permissionEpoch,
        ),
      });
    });

    this.app.get("/v1/sessions/index", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      return context.json({
        ok: true,
        sessions: await this.options.backend.getSessionIndex(),
      });
    });

    for (const [suffix, kind, field] of [
      ["view", "getSessionView", "view"],
      ["history", "getSessionHistory", "history"],
      ["control", "getSessionControl", "control"],
    ] as const) {
      this.app.get(`/v1/sessions/:id/${suffix}`, async (context) => {
        const authorization = this.authorizePromptMutation(context);
        if ("response" in authorization) return authorization.response;
        const raw: Record<string, string | undefined> = context.req.query();
        const query = parseSessionQuery({
          ...raw,
          sessionId: context.req.param("id"),
          bindingGeneration: Number(raw.bindingGeneration),
          ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
        });
        const result = await sessionReadForClient({
          backend: this.options.backend,
          views: this.clientViews,
          clientId: authorization.clientId,
          epoch: this.permissionEpoch,
          kind,
          query: { ...query, signal: context.req.raw.signal },
        });
        return context.json({ ok: true, [field]: result });
      });
    }
    this.app.get("/v1/prompts/receipt", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, string | undefined> = context.req.query();
      const query = parseSessionQuery(
        { ...raw, bindingGeneration: Number(raw.bindingGeneration) },
        true,
      );
      const result = await receiptForClient({
        backend: this.options.backend,
        views: this.clientViews,
        clientId: authorization.clientId,
        epoch: this.permissionEpoch,
        query: { ...query, signal: context.req.raw.signal },
      });
      return context.json({ ok: true, result });
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
          this.clientViews.binding(clientId, this.permissionEpoch)
            .rootSessionId,
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
      if (!this.clientViews.isRegistered(clientId))
        return context.json(webErrorBody("client is not registered"), 409);
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

      await this.commandBackend("server-rest", { clientId }).executeCommand(
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
        const model = await this.commandBackend("server-rest", {
          clientId,
        }).connectModel(input);
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
        const search = await this.commandBackend("server-rest", {
          clientId,
        }).setSearchApiKey(input);
        return context.json({ ok: true, search });
      } catch (error) {
        return context.json(
          webErrorBody(errorMessage(error)),
          mutationErrorStatus(error),
        );
      }
    });

    this.app.patch("/v1/sessions/:id/reasoning", async (context) => {
      if (!this.isAuthorized(context.req.header("authorization")))
        return context.json(webErrorBody("Unauthorized"), 401);
      const clientId = this.clientIdFromRequest(context);
      if (!clientId)
        return context.json(webErrorBody("clientId is required"), 400);
      if (!this.isRegisteredWebClient(clientId))
        return context.json(webErrorBody("client is not registered"), 409);
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (body.reasoning !== null && !isUiReasoningConfig(body.reasoning))
        return context.json(webErrorBody("Invalid reasoning preference"), 400);
      try {
        const session = await this.commandBackend("server-rest", {
          clientId,
        }).updateSessionReasoning({
          sessionId: context.req.param("id"),
          reasoning: body.reasoning,
        });
        return context.json({ ok: true, session });
      } catch (error) {
        return context.json(webErrorBody(errorMessage(error)), 400);
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

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const body = parsed.value;
      if (
        !isRecord(body) ||
        (body.reuseEmpty !== undefined && typeof body.reuseEmpty !== "boolean")
      )
        return context.json(webErrorBody("reuseEmpty must be a boolean"), 400);
      if (body.options !== undefined && body.reuseEmpty !== undefined)
        return context.json(
          webErrorBody("Use either options or reuseEmpty, not both"),
          400,
        );
      let options: Parameters<UiBackendClient["createSession"]>[0];
      try {
        options =
          body.options !== undefined
            ? parseSessionCreationOptions(body.options)
            : body.reuseEmpty === true
              ? { reuseInactiveEmpty: { excludeSessionIds: [] } }
              : undefined;
      } catch {
        return context.json(
          webErrorBody("Invalid session creation options"),
          400,
        );
      }
      const { session, binding, changed, created } =
        await createOrReuseClientSession(
          this.options.backend,
          this.clientViews,
          clientId,
          this.permissionEpoch,
          options,
        );
      if (changed) this.notifyBinding(clientId);
      this.clientViews.assertBinding(clientId, binding, this.permissionEpoch);
      return context.json({
        ok: true,
        session,
        created,
        ...binding,
        ...sessionRecoveryCapability(
          this.options.backend,
          this.permissionEpoch,
        ),
      });
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

      const binding = await selectPermissionSession(
        this.options.backend,
        this.clientViews,
        clientId,
        sessionId,
        this.permissionEpoch,
      );
      this.notifyBinding(clientId);
      return context.json({
        ok: true,
        ...binding,
        ...sessionRecoveryCapability(
          this.options.backend,
          this.permissionEpoch,
        ),
      });
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
        await this.commandBackend("server-rest", { clientId }).archiveSession({
          sessionId,
        });
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
        const compact = await this.commandBackend("server-rest", {
          clientId,
        }).compactSession({
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
        return context.json(promptRejectionBody("Unauthorized"), 401);
      }
      const clientId = this.clientIdFromRequest(context);
      if (!clientId) {
        return context.json(promptRejectionBody("clientId is required"), 400);
      }
      if (!this.isRegisteredWebClient(clientId)) {
        return context.json(
          promptRejectionBody("client is not registered"),
          409,
        );
      }

      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          promptRejectionBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (body.reasoning !== undefined && !isUiReasoningConfig(body.reasoning))
        return context.json(
          promptRejectionBody("Invalid reasoning preference"),
          400,
        );
      const text = asNonEmptyString(body.text);
      if (!text) {
        return context.json(promptRejectionBody("text is required"), 400);
      }
      const sessionId = asNonEmptyString(body.sessionId);
      const clientRequestId = asNonEmptyString(body.clientRequestId);
      if (!clientRequestId || clientRequestId.startsWith("legacy:")) {
        return context.json(
          {
            error: {
              code: "INVALID_CLIENT_REQUEST_ID",
              message:
                "clientRequestId is required and must not use the reserved legacy: prefix",
            },
            ok: false,
          },
          400,
        );
      }
      const commandBackend = this.commandBackend("server-rest", { clientId });
      const priorGeneration = this.clientViews.binding(
        clientId,
        this.permissionEpoch,
      ).bindingGeneration;
      try {
        const accepted = await acceptDaemonPrompt({
          backend: commandBackend,
          clientId,
          clientViews: this.clientViews,
          createSessionId: this.createSessionId,
          options: {
            clientRequestId,
            ...(body.reasoning === undefined
              ? {}
              : { reasoning: body.reasoning }),
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          permissionRouter: this.permissionRouter,
          text,
        });
        return context.json(
          {
            ok: true,
            ...accepted.receipt,
            ...this.clientViews.binding(clientId, this.permissionEpoch),
            ...sessionRecoveryCapability(
              this.options.backend,
              this.permissionEpoch,
            ),
          },
          202,
        );
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptAdmissionStatus(error),
        );
      } finally {
        if (
          !this.clientViews.isPromptBindingProvisional(clientId) &&
          this.clientViews.binding(clientId, this.permissionEpoch)
            .bindingGeneration !== priorGeneration
        )
          this.notifyBinding(clientId);
      }
    });

    this.app.patch("/v1/prompts/:id", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) {
        return authorization.response;
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
      const editLeaseId = asNonEmptyString(body.editLeaseId);
      if (!text || !editLeaseId) {
        return context.json(
          webErrorBody("text and editLeaseId are required"),
          400,
        );
      }
      try {
        if (
          !this.clientViews.canAccessPrompt(
            authorization.clientId,
            await this.options.backend.getSnapshot(),
            context.req.param("id"),
          )
        ) {
          return context.json(
            webErrorBody("Prompt belongs to another session"),
            403,
          );
        }
        const prompt = await editQueuedPromptForClient(
          this.commandBackend("server-rest", {
            clientId: authorization.clientId,
          }),
          {
            editLeaseId,
            promptId: context.req.param("id"),
            text,
          } satisfies UiEditQueuedPromptInput,
          authorization.clientId,
        );
        return context.json({ ok: true, prompt });
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptMutationStatus(error),
        );
      }
    });

    this.app.get("/v1/prompts/:id/completion", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) {
        return authorization.response;
      }
      const promptId = context.req.param("id");
      try {
        if (
          !this.clientViews.canAccessPrompt(
            authorization.clientId,
            await this.options.backend.getSnapshot(),
            promptId,
          )
        ) {
          return context.json(
            webErrorBody("Prompt is unavailable to this client"),
            403,
          );
        }
        const completion = await this.waitForPrompt(
          this.options.backend,
          promptId,
          context.req.raw.signal,
        );
        return context.json({ completion, ok: true });
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptMutationStatus(error),
        );
      }
    });

    this.app.delete("/v1/prompts/:id", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) {
        return authorization.response;
      }
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const editLeaseId = asNonEmptyString(body.editLeaseId);
      try {
        if (
          !this.clientViews.canAccessPrompt(
            authorization.clientId,
            await this.options.backend.getSnapshot(),
            context.req.param("id"),
          )
        ) {
          return context.json(
            webErrorBody("Prompt belongs to another session"),
            403,
          );
        }
        const prompt = await cancelQueuedPromptForClient(
          this.commandBackend("server-rest", {
            clientId: authorization.clientId,
          }),
          {
            ...(editLeaseId === undefined ? {} : { editLeaseId }),
            promptId: context.req.param("id"),
          } satisfies UiCancelQueuedPromptInput,
          authorization.clientId,
        );
        return context.json({ ok: true, prompt });
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptMutationStatus(error),
        );
      }
    });

    this.app.post("/v1/prompts/:id/edit-lease", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      try {
        if (
          !this.clientViews.canAccessPrompt(
            authorization.clientId,
            await this.options.backend.getSnapshot(),
            context.req.param("id"),
          )
        ) {
          return context.json(
            webErrorBody("Prompt belongs to another session"),
            403,
          );
        }
        const lease = await acquirePromptEditLeaseForClient(
          this.commandBackend("server-rest", {
            clientId: authorization.clientId,
          }),
          { promptId: context.req.param("id") },
          authorization.clientId,
        );
        return context.json({ lease, ok: true });
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptMutationStatus(error),
        );
      }
    });

    this.app.patch("/v1/prompts/:id/edit-lease", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const editLeaseId = asNonEmptyString(body.editLeaseId);
      if (!editLeaseId) {
        return context.json(webErrorBody("editLeaseId is required"), 400);
      }
      try {
        const lease = await renewPromptEditLeaseForClient(
          this.commandBackend("server-rest", {
            clientId: authorization.clientId,
          }),
          { editLeaseId, promptId: context.req.param("id") },
          authorization.clientId,
        );
        return context.json({ lease, ok: true });
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptMutationStatus(error),
        );
      }
    });

    this.app.delete("/v1/prompts/:id/edit-lease", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const editLeaseId = asNonEmptyString(body.editLeaseId);
      if (!editLeaseId) {
        return context.json(webErrorBody("editLeaseId is required"), 400);
      }
      try {
        const prompt = await releasePromptEditLeaseForClient(
          this.commandBackend("server-rest", {
            clientId: authorization.clientId,
          }),
          {
            editLeaseId,
            promptId: context.req.param("id"),
          } satisfies UiReleasePromptEditLeaseInput,
          authorization.clientId,
        );
        return context.json({ ok: true, prompt });
      } catch (error) {
        return context.json(
          promptErrorBody(error),
          promptMutationStatus(error),
        );
      }
    });

    this.app.post("/v1/interactions/:id/respond", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) {
        return authorization.response;
      }
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok) {
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (!isRecord(body.response)) {
        return context.json(webErrorBody("response is required"), 400);
      }
      try {
        await respondInteractionForClient({
          backend: this.commandBackend("server-rest", {
            clientId: authorization.clientId,
          }),
          clientId: authorization.clientId,
          clientViews: this.clientViews,
          interactionId: context.req.param("id"),
          response: body.response as Parameters<
            UiBackendClient["respondInteraction"]
          >[1],
        });
        return context.json({ ok: true });
      } catch (error) {
        return context.json(
          webErrorBody(errorMessage(error)),
          isDaemonForbiddenError(error) ? 403 : mutationErrorStatus(error),
        );
      }
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

      const permission = await this.commandBackend("server-rest", {
        clientId,
      }).setPermission({
        ...(level === undefined ? {} : { level }),
        ...(mode === undefined ? {} : { mode }),
      });
      return context.json({ ok: true, permission });
    });

    this.app.get("/v1/permissions", async (context) => {
      const authorization = this.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const rootSessionId = context.req.query("rootSessionId");
      const expected = parsePermissionBinding({
        rootSessionId: rootSessionId === "" ? null : (rootSessionId ?? null),
        permissionEpoch: context.req.query("permissionEpoch"),
        bindingGeneration: Number(context.req.query("bindingGeneration")),
      });
      const snapshot = await permissionSnapshotForClient(
        this.options.backend,
        this.clientViews,
        authorization.clientId,
        expected,
        this.permissionEpoch,
      );
      return context.json({ ok: true, snapshot });
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
      await respondPermissionForClient(
        this.commandBackend("server-rest", { clientId }),
        this.clientViews,
        clientId,
        requestId,
        response,
        parsePermissionBinding(body.context),
        this.permissionEpoch,
      );
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
      if (!isRecord(parsed.value)) {
        return context.json(
          webErrorBody("request body must be an object"),
          400,
        );
      }
      const body = parsed.value;
      const hasRunId = Object.hasOwn(body, "runId");
      const requestedRunId = asNonEmptyString(body.runId);
      if (hasRunId && requestedRunId === undefined) {
        return context.json(
          webErrorBody("runId must be a non-empty string"),
          400,
        );
      }
      if (!requestedRunId)
        return context.json(webErrorBody("An exact runId is required"), 400);
      await abortForClient({
        backend: this.commandBackend("server-rest", { clientId }),
        views: this.clientViews,
        clientId,
        epoch: this.permissionEpoch,
        query: parseSessionQuery({
          ...body,
          sessionId: context.req.param("id"),
        }),
        runId: requestedRunId,
      });
      return context.json({ ok: true });
    });

    this.app.get("/", (context) => this.serveWebAsset(context));
    this.app.get("/*", (context) => this.serveWebAsset(context));
  }

  private isAuthorized(authorization: string | undefined): boolean {
    return isAuthorized(authorization, this.authToken);
  }

  private authorizePromptMutation(
    context: Context,
  ): { readonly clientId: string } | { readonly response: Response } {
    if (!this.isAuthorized(context.req.header("authorization"))) {
      return { response: context.json(webErrorBody("Unauthorized"), 401) };
    }
    const clientId = this.clientIdFromRequest(context);
    if (!clientId) {
      return {
        response: context.json(webErrorBody("clientId is required"), 400),
      };
    }
    if (!this.isRegisteredWebClient(clientId)) {
      return {
        response: context.json(webErrorBody("client is not registered"), 409),
      };
    }
    return { clientId };
  }

  private isRegisteredWebClient(clientId: string): boolean {
    return this.clientViews.isRegistered(clientId);
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
        ...(webAssets.workspaceDirectory === undefined
          ? {}
          : { directory: webAssets.workspaceDirectory }),
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
        this.clientViews.setClientSessionOccupancy(clientId, true);
        this.cancelClientRoutingCleanup(clientId);
        this.knownClientIds.add(clientId);
        this.options.onClientConnected?.(clientId);
        client.write({
          clientId,
          type: "hello",
          ...this.clientViews.binding(clientId, this.permissionEpoch),
          ...sessionRecoveryCapability(
            this.options.backend,
            this.permissionEpoch,
          ),
        });
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
    if (!this.hasConnectedClient(client.clientId)) {
      this.clientViews.setClientSessionOccupancy(client.clientId, false);
      this.scheduleClientRoutingCleanup(client.clientId);
    }
    this.options.onClientDisconnected?.(client.clientId);
  }

  private hasConnectedClient(clientId: string): boolean {
    for (const client of this.clients) {
      if (client.clientId === clientId) {
        return true;
      }
    }
    return false;
  }

  private cancelClientRoutingCleanup(clientId: string): void {
    const timer = this.disconnectCleanupTimers.get(clientId);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.disconnectCleanupTimers.delete(clientId);
  }

  private touchClientActivity(clientId: string): void {
    this.knownClientIds.add(clientId);
    this.clientViews.setClientSessionOccupancy(clientId, true);
    if (!this.hasConnectedClient(clientId))
      this.scheduleClientRoutingCleanup(clientId);
  }

  private scheduleClientRoutingCleanup(clientId: string): void {
    this.cancelClientRoutingCleanup(clientId);
    const timer = setTimeout(() => {
      if (this.disconnectCleanupTimers.get(clientId) !== timer) return;
      this.disconnectCleanupTimers.delete(clientId);
      if (this.hasConnectedClient(clientId)) return;
      this.clientViews.setClientSessionOccupancy(clientId, false);
      if (this.clientViews.hasPendingSessionOperation(clientId)) {
        this.scheduleClientRoutingCleanup(clientId);
        return;
      }
      const interactionIds = this.clientViews.disconnectClient(clientId);
      this.knownClientIds.delete(clientId);
      this.expiredClientIds.add(clientId);
      this.cancelRemovedClientInteractions(interactionIds);
    }, this.clientDisconnectRetentionMs);
    this.disconnectCleanupTimers.set(clientId, timer);
  }

  private cancelRemovedClientInteractions(
    interactionIds: readonly string[],
  ): void {
    for (const interactionId of interactionIds) {
      void this.options.backend
        .respondInteraction(interactionId, {
          kind: "cancelled",
          reason: "client-disconnected",
        })
        .catch((error: unknown) => {
          if (!isRecord(error) || error.code !== "INTERACTION_NOT_FOUND") {
            reportInteractionCleanupFailure(
              this.options.logger ?? NOOP_LOGGER,
              error,
            );
          }
        });
    }
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

  private notifyBinding(clientId: string): void {
    for (const client of [...this.clients]) {
      if (client.clientId !== clientId) continue;
      try {
        client.write({
          type: "hello",
          clientId,
          ...this.clientViews.binding(clientId, this.permissionEpoch),
          ...sessionRecoveryCapability(
            this.options.backend,
            this.permissionEpoch,
          ),
        });
      } catch {
        this.disconnectClient(client);
      }
    }
  }

  private broadcastPermission(event: UiEvent): void {
    for (const client of [...this.clients]) {
      try {
        const binding = this.clientViews.binding(
          client.clientId,
          this.permissionEpoch,
        );
        const routed = this.permissionRouter.filterEventForClient(
          event,
          binding.rootSessionId,
        );
        if (routed)
          client.write({
            type: "ui.event",
            event: {
              ...routed,
              bindingGeneration: binding.bindingGeneration,
            } as UiEvent,
          });
      } catch {
        this.disconnectClient(client);
      }
    }
  }

  private async reconcileSessionBindings(): Promise<void> {
    const previous = [...this.knownClientIds]
      .filter((id) => this.clientViews.isRegistered(id))
      .map((id) => ({
        id,
        binding: this.clientViews.binding(id, this.permissionEpoch),
      }));
    const index = await this.options.backend.getSessionIndex();
    const roots = new Set(
      index
        .filter((session) => !session.parentId && !session.isSubagent)
        .map((session) => session.id),
    );
    for (const { id, binding } of previous) {
      if (!binding.rootSessionId || roots.has(binding.rootSessionId)) continue;
      try {
        this.clientViews.assertBinding(id, binding, this.permissionEpoch);
        this.clientViews.selectSession(id, null, binding.bindingGeneration);
        this.notifyBinding(id);
      } catch {
        /* A newer client selection owns the binding. */
      }
    }
  }

  private broadcast(envelope: EventEnvelope): void {
    const event = envelope.event;
    const previousBindings =
      event.type === "command.result.delivered" &&
      event.action?.kind === "session.selected"
        ? new Map(
            [...this.knownClientIds]
              .filter((id) => this.clientViews.isRegistered(id))
              .map((id) => [
                id,
                this.clientViews.binding(id, this.permissionEpoch)
                  .bindingGeneration,
              ]),
          )
        : undefined;
    this.clientViews.observeEvent(event);
    const replayEvents = this.routeEnvelopeForKnownClients(envelope);
    this.replayEventsBySeqNum.set(envelope.seqNum, replayEvents);
    for (const client of Array.from(this.clients)) {
      const routed = replayEvents.get(client.clientId);
      if (routed) {
        try {
          client.write({ event: routed, type: "ui.event" }, envelope.seqNum);
        } catch {
          this.disconnectClient(client);
        }
      }
    }
    this.clientViews.afterEventBroadcast(event);
    if (event.type === "session.index.invalidated")
      void this.reconcileSessionBindings().catch(() => undefined);
    if (
      event.type === "command.result.delivered" &&
      event.action?.kind === "session.selected"
    ) {
      for (const [clientId, generation] of previousBindings ?? []) {
        if (
          this.clientViews.binding(clientId, this.permissionEpoch)
            .bindingGeneration !== generation
        )
          this.notifyBinding(clientId);
      }
    }
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
      this.clientViews.binding(clientId, this.permissionEpoch).rootSessionId,
    );
    if (!filtered || filtered.type === "snapshot.replaced") return undefined;
    if (
      filtered.type === "session.changed" ||
      filtered.type === "session.unavailable"
    ) {
      return {
        ...filtered,
        bindingGeneration: this.clientViews.binding(
          clientId,
          this.permissionEpoch,
        ).bindingGeneration,
      };
    }
    return this.projectSelectionForBinding(filtered, clientId, false);
  }

  private projectSelectionForBinding(
    event: UiEvent,
    clientId: string,
    replay: boolean,
  ): UiEvent {
    const selected = this.clientViews.binding(
      clientId,
      this.permissionEpoch,
    ).rootSessionId;
    if (event.type === "session.index.invalidated")
      return { ...event, selectedSessionId: selected };
    if (
      event.type === "command.result.delivered" &&
      event.action?.kind === "session.selected" &&
      (replay ||
        !isRecord(event.action.data) ||
        event.action.data.choiceId !== selected)
    ) {
      // hello owns reconnect selection; historical command results remain visible
      // but their one-shot selection action must never execute again.
      const { action: _action, ...result } = event;
      return result;
    }
    return event;
  }

  private writeReplayEnvelopeToClient(
    envelope: EventEnvelope,
    client: SseClient,
  ): void {
    const routed = this.replayEventsBySeqNum
      .get(envelope.seqNum)
      ?.get(client.clientId);
    if (routed) {
      client.write(
        {
          event: this.projectSelectionForBinding(routed, client.clientId, true),
          type: "ui.event",
        },
        envelope.seqNum,
      );
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
      return runtime.dispose();
    },
    start(): Promise<void> {
      return runtime.start();
    },
  };
}
