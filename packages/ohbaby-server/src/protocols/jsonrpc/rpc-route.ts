import { SessionRunBusyError } from "ohbaby-agent";
import type { SubmitPromptOptions, UiBackendClient } from "ohbaby-sdk";
import {
  parseDaemonStartupIntent,
  type DaemonClientViewCoordinator,
} from "../../coordination/client-view.js";
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
} from "./protocol.js";

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

type ExecuteCommandInvocation = Parameters<
  UiBackendClient["executeCommand"]
>[0];

export class DaemonForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonForbiddenError";
  }
}

export function isDaemonForbiddenError(
  error: unknown,
): error is DaemonForbiddenError {
  return error instanceof DaemonForbiddenError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function createDefaultDaemonPromptQueue(
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

export function parseDaemonRpcBody(body: string): {
  readonly failure?: DaemonRpcResponse;
  readonly request?: DaemonRpcRequest;
  readonly status: number;
} {
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
    return {
      failure: createDaemonRpcFailure(
        "unknown",
        new Error("Request body is too large"),
      ),
      status: 400,
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = body.length > 0 ? (JSON.parse(body) as unknown) : {};
    return {
      request: parseDaemonRpcRequest(parsedBody),
      status: 200,
    };
  } catch (error) {
    return {
      failure: createDaemonRpcFailure(requestIdFromBody(parsedBody), error),
      status: 400,
    };
  }
}

export async function callDaemonBackend(input: {
  readonly backend: UiBackendClient;
  readonly clientViews: DaemonClientViewCoordinator;
  readonly createSessionId: () => string;
  readonly permissionRouter: PermissionRouter;
  readonly promptQueue: DaemonPromptQueue;
  readonly request: DaemonRpcRequest;
}): Promise<unknown> {
  const {
    backend,
    clientViews,
    createSessionId,
    permissionRouter,
    promptQueue,
    request,
  } = input;

  switch (request.method) {
    case "getSnapshot": {
      const snapshot = await backend.getSnapshot();
      return permissionRouter.filterSnapshotForClient(
        clientViews.projectSnapshot(request.clientId, snapshot),
        request.clientId,
      );
    }
    case "initializeClient": {
      const snapshot = await backend.getSnapshot();
      clientViews.initializeClient(
        request.clientId,
        snapshot,
        parseDaemonStartupIntent(request.params[0]),
      );
      return undefined;
    }
    case "getContextWindowUsage":
      return backend.getContextWindowUsage(
        request.params[0] as Parameters<
          UiBackendClient["getContextWindowUsage"]
        >[0],
      );
    case "listCommands":
      return backend.listCommands(
        request.params[0] as Parameters<UiBackendClient["listCommands"]>[0],
      );
    case "submitPrompt": {
      const options = submitPromptOptions(request.params[1]);
      const prepared = clientViews.preparePromptSubmit(
        request.clientId,
        options,
        createSessionId,
      );
      await promptQueue.enqueue({
        clientId: request.clientId,
        ...(prepared.options === undefined
          ? {}
          : { options: prepared.options }),
        ...(prepared.sessionId === undefined
          ? {}
          : { sessionId: prepared.sessionId }),
        text: request.params[0] as string,
      });
      return undefined;
    }
    case "compactSession":
      return backend.compactSession(
        request.params[0] as Parameters<UiBackendClient["compactSession"]>[0],
      );
    case "archiveSession":
      return backend.archiveSession(
        request.params[0] as Parameters<UiBackendClient["archiveSession"]>[0],
      );
    case "getCurrentModel":
      return backend.getCurrentModel();
    case "probeModelContextWindow":
      return backend.probeModelContextWindow(
        request.params[0] as Parameters<
          UiBackendClient["probeModelContextWindow"]
        >[0],
      );
    case "connectModel":
      return backend.connectModel(
        request.params[0] as Parameters<UiBackendClient["connectModel"]>[0],
      );
    case "setSearchApiKey":
      return backend.setSearchApiKey(
        request.params[0] as Parameters<UiBackendClient["setSearchApiKey"]>[0],
      );
    case "setPermission":
      return backend.setPermission(
        request.params[0] as Parameters<UiBackendClient["setPermission"]>[0],
      );
    case "executeCommand": {
      const invocation = clientViews.prepareCommandInvocation(
        request.clientId,
        request.params[0] as ExecuteCommandInvocation,
      );
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
        request.params[1] as Parameters<
          UiBackendClient["respondPermission"]
        >[1],
      );
    case "respondInteraction":
      return backend.respondInteraction(
        request.params[0] as string,
        request.params[1] as Parameters<
          UiBackendClient["respondInteraction"]
        >[1],
      );
    case "abortRun":
      return backend.abortRun(request.params[0] as string | undefined);
  }
}

export function createDaemonRpcSuccessResponse(
  request: DaemonRpcRequest,
  result: unknown,
): DaemonRpcResponse {
  return createDaemonRpcSuccess(request.id, result);
}
