import type {
  SubmitPromptOptions,
  UiAcquirePromptEditLeaseInput,
  UiBackendClient,
  UiCancelQueuedPromptInput,
  UiEditQueuedPromptInput,
  UiReleasePromptEditLeaseInput,
  UiRenewPromptEditLeaseInput,
} from "ohbaby-sdk";
import {
  DaemonForbiddenError,
  isDaemonForbiddenError,
  parseDaemonStartupIntent,
  respondInteractionForClient,
  type DaemonClientViewCoordinator,
} from "../../coordination/client-view.js";
import { PermissionRouter } from "../../coordination/permission-router.js";
import {
  acquirePromptEditLeaseForClient,
  acceptDaemonPrompt,
  renewPromptEditLeaseForClient,
} from "../../coordination/prompt-backend.js";
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

export { DaemonForbiddenError, isDaemonForbiddenError };

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
  if (
    typeof value.clientRequestId === "string" &&
    (value.clientRequestId.trim() === "" ||
      value.clientRequestId.startsWith("legacy:"))
  ) {
    const error = new Error(
      "clientRequestId must be non-empty and must not use the reserved legacy: prefix",
    ) as Error & { code: string };
    error.code = "INVALID_CLIENT_REQUEST_ID";
    throw error;
  }
  return {
    ...(typeof value.clientRequestId === "string"
      ? { clientRequestId: value.clientRequestId }
      : {}),
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
  };
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
  readonly request: DaemonRpcRequest;
}): Promise<unknown> {
  const { backend, clientViews, createSessionId, permissionRouter, request } =
    input;

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
    case "submitPromptAccepted": {
      const accepted = await acceptDaemonPrompt({
        backend,
        clientId: request.clientId,
        clientViews,
        createSessionId,
        options: submitPromptOptions(request.params[1]),
        permissionRouter,
        text: request.params[0] as string,
      });
      return accepted.receipt;
    }
    case "editQueuedPrompt": {
      const input = request.params[0] as UiEditQueuedPromptInput;
      if (
        !clientViews.canAccessPrompt(
          request.clientId,
          await backend.getSnapshot(),
          input.promptId,
        )
      ) {
        throw new DaemonForbiddenError("Prompt belongs to another session");
      }
      return backend.editQueuedPrompt(input);
    }
    case "cancelQueuedPrompt": {
      const input = request.params[0] as UiCancelQueuedPromptInput;
      if (
        !clientViews.canAccessPrompt(
          request.clientId,
          await backend.getSnapshot(),
          input.promptId,
        )
      ) {
        throw new DaemonForbiddenError("Prompt belongs to another session");
      }
      return backend.cancelQueuedPrompt(input);
    }
    case "acquirePromptEditLease": {
      const input = request.params[0] as UiAcquirePromptEditLeaseInput;
      if (
        !clientViews.canAccessPrompt(
          request.clientId,
          await backend.getSnapshot(),
          input.promptId,
        )
      ) {
        throw new DaemonForbiddenError("Prompt belongs to another session");
      }
      return acquirePromptEditLeaseForClient(
        backend,
        input,
        request.clientId,
      );
    }
    case "renewPromptEditLease": {
      const input = request.params[0] as UiRenewPromptEditLeaseInput;
      return renewPromptEditLeaseForClient(backend, input, request.clientId);
    }
    case "releasePromptEditLease": {
      const input = request.params[0] as UiReleasePromptEditLeaseInput;
      return backend.releasePromptEditLease(input);
    }
    case "waitForPrompt": {
      const promptId = request.params[0] as string;
      if (
        !clientViews.canAccessPrompt(
          request.clientId,
          await backend.getSnapshot(),
          promptId,
        )
      ) {
        throw new DaemonForbiddenError("Prompt belongs to another session");
      }
      return backend.waitForPrompt(promptId);
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
    case "respondInteraction": {
      const interactionId = request.params[0] as string;
      await respondInteractionForClient({
        backend,
        clientId: request.clientId,
        clientViews,
        interactionId,
        response: request.params[1] as Parameters<
          UiBackendClient["respondInteraction"]
        >[1],
      });
      return undefined;
    }
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
