import type { Context } from "hono";
import type {
  UiCommandCorrelation,
  InstanceSettingsReader,
  InstanceSettingsControl,
  UiPromptQueueExecutionPort,
} from "ohbaby-agent";
import type { UiBackendClient } from "ohbaby-sdk";
import type { DaemonClientViewCoordinator } from "../../../coordination/client-view.js";
import type {
  EventBus,
  EventEnvelope,
} from "../../../coordination/event-bus.js";
import type { PermissionRouter } from "../../../coordination/permission-router.js";

/** Per-workspace dependencies shared by the ordered REST and RPC handlers. */
export interface DaemonRouteContext {
  readonly options: {
    readonly backend: UiBackendClient &
      UiPromptQueueExecutionPort &
      Partial<InstanceSettingsReader & InstanceSettingsControl>;
    readonly packageVersion?: string;
    readonly onShutdown?: () => Promise<void> | void;
  };
  readonly clientViews: DaemonClientViewCoordinator;
  readonly eventBus: EventBus;
  readonly permissionRouter: PermissionRouter;
  readonly createSessionId: () => string;
  /** Read from the runtime on each use, including after asynchronous work. */
  readonly permissionEpoch: string;
  readonly registeredWebClientIds: Set<string>;
  readonly knownClientIds: Set<string>;
  readonly waitControllers: Set<AbortController>;
  commandBackend(
    entryPoint: "server-rest" | "server-rpc",
    correlation: UiCommandCorrelation,
  ): UiBackendClient & UiPromptQueueExecutionPort;
  isAuthorized(authorization: string | undefined): boolean;
  authorizePromptMutation(
    context: Context,
  ): { readonly clientId: string } | { readonly response: Response };
  clientIdFromRequest(context: {
    readonly req: {
      header(name: string): string | undefined;
      query(name: string): string | undefined;
    };
  }): string | undefined;
  isRegisteredWebClient(clientId: string): boolean;
  touchClientActivity(clientId: string): void;
  notifyBinding(clientId: string): void;
  waitForPrompt(
    backend: UiBackendClient,
    promptId: string,
    requestSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<UiBackendClient["waitForPrompt"]>>>;
  createSseResponse(
    clientId: string,
    signal: AbortSignal,
    lastEventId: string | undefined,
  ): Response;
  broadcast(envelope: EventEnvelope): void;
  createOpenApiDocument(): unknown;
}
