import type {
  InstanceSettingsReader,
  InstanceSettingsControl,
} from "ohbaby-agent";
import { registerSettingsRoutes } from "../protocols/web/routes/settings.js";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import {
  createUiCommandGateway,
  type Logger,
  type UiCommandCorrelation,
  type UiCommandRecorder,
  type UiPromptQueueExecutionPort,
} from "ohbaby-agent";
import {
  type UiBackendClient,
  type UiEvent,
  type UiUnsubscribe,
} from "ohbaby-sdk";
import { isAuthorizedDaemonRequest } from "../auth/token.js";
import { DaemonClientViewCoordinator } from "../coordination/client-view.js";
import { EventBus, type EventEnvelope } from "../coordination/event-bus.js";
import {
  PermissionRouter,
  isPermissionEvent,
} from "../coordination/permission-router.js";
import {
  isDaemonForbiddenError,
  registerRpcRoute,
} from "../protocols/jsonrpc/rpc-route.js";

import {
  CLIENT_ID_HEADER,
  asNonEmptyString,
  errorMessage,
  isRecord,
  webErrorBody,
} from "../protocols/web/request-helpers.js";

import { registerCommandRoutes } from "../protocols/web/routes/commands.js";
import type { DaemonRouteContext } from "../protocols/web/routes/context.js";
import {
  registerClientRoutes,
  registerEventRoutes,
  registerLegacyEventRoutes,
  registerSnapshotRoutes,
} from "../protocols/web/routes/events.js";
import { registerModelRoutes } from "../protocols/web/routes/model.js";
import {
  registerInteractionRoutes,
  registerPermissionRoutes,
} from "../protocols/web/routes/permissions.js";
import {
  registerPromptLeaseRoutes,
  registerPromptMutationRoutes,
  registerPromptReceiptRoutes,
} from "../protocols/web/routes/prompts.js";
import {
  registerSessionAbortRoutes,
  registerSessionMutationRoutes,
  registerSessionReadRoutes,
} from "../protocols/web/routes/sessions.js";
import { registerSubagentRoutes } from "../protocols/web/routes/subagents.js";
import { registerSystemRoutes } from "../protocols/web/routes/system.js";
import { createOpenApiDocument } from "./openapi.js";
import { DaemonSseHub } from "./sse-hub.js";
import { serveWebAsset, type WebAssetsOptions } from "./static-assets.js";

export interface DaemonServerAppOptions {
  readonly backend: UiBackendClient &
    UiPromptQueueExecutionPort &
    Partial<InstanceSettingsReader & InstanceSettingsControl>;
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

export interface DaemonServerAppHandle {
  readonly app: Hono;
  dispose(): Promise<void>;
  start(): Promise<void>;
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

class DaemonServerAppRuntime implements DaemonRouteContext {
  private readonly sseHub: DaemonSseHub;
  readonly app = new Hono();
  private readonly commandRecorder: UiCommandRecorder;
  readonly clientViews = new DaemonClientViewCoordinator();
  readonly createSessionId: () => string;
  readonly eventBus: EventBus;
  readonly knownClientIds = new Set<string>();
  private readonly authToken: string;
  readonly permissionRouter: PermissionRouter;
  readonly registeredWebClientIds = new Set<string>();
  readonly waitControllers = new Set<AbortController>();
  private started = false;
  private unsubscribe: UiUnsubscribe | undefined;
  private unsubscribePermissions: UiUnsubscribe | undefined;
  private currentPermissionEpoch = "";

  get permissionEpoch(): string {
    return this.currentPermissionEpoch;
  }

  constructor(readonly options: DaemonServerAppOptions) {
    this.clientViews.setSubagentUnwatchHandler((selection) => {
      void this.options.backend
        .releaseSubagentConversation?.({ ...selection })
        .catch(() => undefined);
    });
    this.authToken = requireAuthToken(options.authToken);
    this.sseHub = new DaemonSseHub(
      this,
      options,
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
      this.currentPermissionEpoch = (
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
          this.sseHub.disconnectClients();
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

    this.sseHub.dispose();
    this.started = false;
  }

  commandBackend(
    entryPoint: "server-rest" | "server-rpc",
    correlation: UiCommandCorrelation,
  ): UiBackendClient & UiPromptQueueExecutionPort {
    return createUiCommandGateway(this.options.backend, {
      correlation,
      entryPoint,
      recorder: this.commandRecorder,
    });
  }

  async waitForPrompt(
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
    registerSystemRoutes(this.app, this);
    registerRpcRoute(this.app, this);
    registerLegacyEventRoutes(this.app, this);
    registerClientRoutes(this.app, this);
    registerSessionReadRoutes(this.app, this);
    registerSubagentRoutes(this.app, this);
    registerPromptReceiptRoutes(this.app, this);
    registerSnapshotRoutes(this.app, this);
    registerEventRoutes(this.app, this);
    registerCommandRoutes(this.app, this);
    registerModelRoutes(this.app, this);
    registerSettingsRoutes(this.app, this);
    registerSessionMutationRoutes(this.app, this);
    registerPromptMutationRoutes(this.app, this);
    registerPromptLeaseRoutes(this.app, this);
    registerInteractionRoutes(this.app, this);
    registerPermissionRoutes(this.app, this);
    registerSessionAbortRoutes(this.app, this);
    this.app.get("/", (context) =>
      serveWebAsset(context, this.options.webAssets, this.authToken),
    );
    this.app.get("/*", (context) =>
      serveWebAsset(context, this.options.webAssets, this.authToken),
    );
  }

  isAuthorized(authorization: string | undefined): boolean {
    return isAuthorized(authorization, this.authToken);
  }

  authorizePromptMutation(
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

  isRegisteredWebClient(clientId: string): boolean {
    return this.clientViews.isRegistered(clientId);
  }

  clientIdFromRequest(context: {
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

  createOpenApiDocument(): unknown {
    return createOpenApiDocument(this.options.packageVersion);
  }
  createSseResponse(
    clientId: string,
    signal: AbortSignal,
    lastEventId: string | undefined,
  ): Response {
    return this.sseHub.createSseResponse(clientId, signal, lastEventId);
  }
  touchClientActivity(clientId: string): void {
    this.sseHub.touchClientActivity(clientId);
  }
  notifyBinding(clientId: string): void {
    this.sseHub.notifyBinding(clientId);
  }
  private broadcastPermission(event: UiEvent): void {
    this.sseHub.broadcastPermission(event);
  }
  broadcast(envelope: EventEnvelope): void {
    this.sseHub.broadcast(envelope);
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
