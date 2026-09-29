import {
  subagentReadForClient,
  subagentConversationReadForClient,
  watchSubagentConversationForClient,
  unwatchSubagentConversationForClient,
} from "../../coordination/session-access.js";
import {
  createOrReuseClientSession,
  parseSessionCreationOptions,
  abortForClient,
  parseSessionQuery,
  receiptForClient,
  sessionReadForClient,
  sessionRecoveryCapability,
} from "../../coordination/session-access.js";
import { randomUUID } from "node:crypto";
import { isUiReasoningConfig, isUiPromptNamingSource } from "ohbaby-sdk";
import type {
  SubmitPromptOptions,
  UiAcquirePromptEditLeaseInput,
  UiBackendClient,
  UiEvent,
  UiCancelQueuedPromptInput,
  UiEditQueuedPromptInput,
  UiResubmitRetainedPromptInput,
  UiReleasePromptEditLeaseInput,
  UiRenewPromptEditLeaseInput,
} from "ohbaby-sdk";
import {
  parseNewSessionCommandArgs,
  type UiPromptQueueExecutionPort,
} from "ohbaby-agent";
import {
  DaemonForbiddenError,
  isDaemonForbiddenError,
  respondInteractionForClient,
  type DaemonClientViewCoordinator,
} from "../../coordination/client-view.js";
import {
  initializePermissionClient,
  parsePermissionBinding,
  permissionSnapshotForClient,
  respondPermissionForClient,
  selectPermissionSession,
} from "../../coordination/permission-access.js";
import { PermissionRouter } from "../../coordination/permission-router.js";
import {
  acquirePromptEditLeaseForClient,
  acceptDaemonPrompt,
  cancelQueuedPromptForClient,
  steerQueuedPromptForClient,
  editQueuedPromptForClient,
  resubmitRetainedPromptForClient,
  releasePromptEditLeaseForClient,
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
  if (value.reasoning !== undefined && !isUiReasoningConfig(value.reasoning)) {
    const error = new Error("Invalid reasoning preference") as Error & {
      code: string;
    };
    error.code = "INVALID_REASONING";
    throw error;
  }
  if (
    value.namingSource !== undefined &&
    !isUiPromptNamingSource(value.namingSource)
  )
    throw Object.assign(new Error("Invalid naming source"), {
      code: "INVALID_NAMING_SOURCE",
    });
  return {
    ...(value.namingSource !== undefined
      ? { namingSource: value.namingSource }
      : {}),
    ...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
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

// Match the built-in resume command grammar without loading chat history or
// mutating the shared backend selection.
function parseResumeSessionId(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--session_id" || arg === "--session-id") {
      const value = argv[index + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (arg.startsWith("--session_id=") || arg.startsWith("--session-id=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

export async function callDaemonBackend(input: {
  readonly backend: UiBackendClient & UiPromptQueueExecutionPort;
  readonly clientViews: DaemonClientViewCoordinator;
  readonly createSessionId: () => string;
  readonly permissionRouter: PermissionRouter;
  readonly permissionEpoch: string;
  readonly request: DaemonRpcRequest;
  readonly signal?: AbortSignal;
  readonly emitCommandEvent: (event: UiEvent) => void;
}): Promise<unknown> {
  const { backend, clientViews, createSessionId, permissionRouter, request } =
    input;

  switch (request.method) {
    case "getSubagentConversationView":
    case "watchSubagentConversation":
    case "unwatchSubagentConversation": {
      const query = request.params[0] as
        | import("ohbaby-sdk").UiSubagentConversationUnwatchQuery
        | undefined;
      if (!query || typeof query !== "object")
        throw new Error("Invalid subagent conversation query");
      const access = {
        backend,
        views: clientViews,
        clientId: request.clientId,
        epoch: input.permissionEpoch,
        query: { ...query, signal: input.signal },
      };
      if (request.method === "getSubagentConversationView")
        return subagentConversationReadForClient(access);
      if (request.method === "watchSubagentConversation")
        return watchSubagentConversationForClient({
          ...access,
          signal: input.signal,
        });
      unwatchSubagentConversationForClient(access);
      return undefined;
    }
    case "listSubagentExecutions":
    case "getSubagentExecutionView": {
      const raw = request.params[0] as
        | (import("ohbaby-sdk").UiSubagentQuery & {
            executionId?: string;
          })
        | undefined;
      if (
        !raw ||
        typeof raw !== "object" ||
        (request.method === "getSubagentExecutionView" && !raw.executionId)
      )
        throw new Error("Invalid execution query");
      return subagentReadForClient({
        backend,
        views: clientViews,
        clientId: request.clientId,
        epoch: input.permissionEpoch,
        query: {
          ...raw,
          executionId:
            request.method === "getSubagentExecutionView"
              ? raw.executionId
              : undefined,
          signal: input.signal,
        },
      });
    }

    case "getSessionView":
    case "getSessionHistory":
    case "getSessionControl":
      return sessionReadForClient({
        backend,
        views: clientViews,
        clientId: request.clientId,
        epoch: input.permissionEpoch,
        kind: request.method,
        query: {
          ...parseSessionQuery(request.params[0]),
          signal: input.signal,
        },
      });
    case "getPromptReceipt":
      return receiptForClient({
        backend,
        views: clientViews,
        clientId: request.clientId,
        epoch: input.permissionEpoch,
        query: {
          ...parseSessionQuery(request.params[0], true),
          signal: input.signal,
        },
      });
    case "getSnapshot": {
      const snapshot = await backend.getSnapshot();
      return permissionRouter.filterSnapshotForClient(
        clientViews.projectSnapshot(request.clientId, snapshot),
        clientViews.isRegistered(request.clientId)
          ? clientViews.binding(request.clientId, input.permissionEpoch)
              .rootSessionId
          : null,
      );
    }
    case "initializeClient": {
      const binding = await initializePermissionClient(
        backend,
        clientViews,
        request.clientId,
        request.params[0],
        input.permissionEpoch,
      );
      return {
        ...binding,
        ...sessionRecoveryCapability(backend, input.permissionEpoch),
      };
    }
    case "getSessionIndex":
      return backend.getSessionIndex();
    case "getSelectedSessionId":
      return clientViews.binding(request.clientId, input.permissionEpoch)
        .rootSessionId;
    case "getPermissionSnapshot":
      return permissionSnapshotForClient(
        backend,
        clientViews,
        request.clientId,
        parsePermissionBinding(request.params[0]),
        input.permissionEpoch,
      );
    case "selectSession": {
      const binding = await selectPermissionSession(
        backend,
        clientViews,
        request.clientId,
        request.params[0] as string,
        input.permissionEpoch,
        typeof request.params[1] === "number" ? request.params[1] : undefined,
      );
      return {
        ...binding,
        ...sessionRecoveryCapability(backend, input.permissionEpoch),
      };
    }
    case "createSession": {
      const { session, binding } = await createOrReuseClientSession(
        backend,
        clientViews,
        request.clientId,
        input.permissionEpoch,
        parseSessionCreationOptions(request.params[0]),
      );
      return {
        session,
        ...binding,
        ...sessionRecoveryCapability(backend, input.permissionEpoch),
      };
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
      return {
        ...accepted.receipt,
        ...clientViews.binding(request.clientId, input.permissionEpoch),
        ...sessionRecoveryCapability(backend, input.permissionEpoch),
      };
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
      return editQueuedPromptForClient(backend, input, request.clientId);
    }
    case "resubmitRetainedPrompt": {
      const input = request.params[0] as UiResubmitRetainedPromptInput;
      if (
        !isRecord(input) ||
        [input.promptId, input.editLeaseId, input.operationId, input.text].some(
          (value) => typeof value !== "string" || !value.trim(),
        )
      ) {
        throw Object.assign(
          new Error("promptId, editLeaseId, operationId and text are required"),
          { code: "INVALID_ARGUMENT" },
        );
      }
      if (
        !clientViews.canAccessPrompt(
          request.clientId,
          await backend.getSnapshot(),
          input.promptId,
        )
      ) {
        throw new DaemonForbiddenError("Prompt belongs to another session");
      }
      return resubmitRetainedPromptForClient(
        backend,
        {
          promptId: input.promptId,
          editLeaseId: input.editLeaseId,
          operationId: input.operationId,
          text: input.text,
        },
        request.clientId,
        clientViews,
      );
    }
    case "steerQueuedPrompt": {
      const input = request.params[0] as Parameters<
        UiBackendClient["steerQueuedPrompt"]
      >[0];
      if (
        !isRecord(input) ||
        [input.promptId, input.expectedRunId, input.clientRequestId].some(
          (value) => typeof value !== "string" || !value.trim(),
        )
      ) {
        throw Object.assign(
          new Error("promptId, expectedRunId and clientRequestId are required"),
          { code: "INVALID_ARGUMENT" },
        );
      }
      if (
        !clientViews.canAccessPrompt(
          request.clientId,
          await backend.getSnapshot(),
          input.promptId,
        )
      ) {
        throw new DaemonForbiddenError("Prompt belongs to another session");
      }
      return steerQueuedPromptForClient(backend, input, request.clientId);
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
      return cancelQueuedPromptForClient(backend, input, request.clientId);
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
      return acquirePromptEditLeaseForClient(backend, input, request.clientId);
    }
    case "renewPromptEditLease": {
      const input = request.params[0] as UiRenewPromptEditLeaseInput;
      return renewPromptEditLeaseForClient(backend, input, request.clientId);
    }
    case "releasePromptEditLease": {
      const input = request.params[0] as UiReleasePromptEditLeaseInput;
      return releasePromptEditLeaseForClient(backend, input, request.clientId);
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
      return backend.waitForPrompt(promptId, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }
    case "compactSession":
      return backend.compactSession(
        request.params[0] as Parameters<UiBackendClient["compactSession"]>[0],
      );
    case "updateSessionReasoning":
      return backend.updateSessionReasoning(
        request.params[0] as Parameters<
          UiBackendClient["updateSessionReasoning"]
        >[0],
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
      if (invocation.commandId === "new" || invocation.commandId === "resume") {
        const commandRunId = randomUUID();
        const identity = {
          commandRunId,
          clientInvocationId: invocation.clientInvocationId,
        };
        input.emitCommandEvent({
          type: "command.started",
          timestamp: Date.now(),
          command: {
            ...identity,
            commandId: invocation.commandId,
            path: invocation.path,
            surface: invocation.surface,
            ...(invocation.sessionId === undefined
              ? {}
              : { sessionId: invocation.sessionId }),
          },
        });
        const newOptions =
          invocation.commandId === "new"
            ? parseNewSessionCommandArgs(invocation.argv)
            : undefined;
        if (newOptions !== undefined && "code" in newOptions) {
          input.emitCommandEvent({
            type: "command.failed",
            ...identity,
            timestamp: Date.now(),
            error: newOptions,
          });
          return undefined;
        }
        const sessionId = parseResumeSessionId(invocation.argv);
        if (invocation.commandId === "resume" && sessionId === undefined) {
          input.emitCommandEvent({
            type: "command.failed",
            ...identity,
            timestamp: Date.now(),
            error: {
              code: "SESSION_ID_REQUIRED",
              message: "Use /resume --session_id <id> to resume a session",
              recoverable: true,
            },
          });
          return undefined;
        }
        try {
          let selectedId: string;
          let output: Extract<
            UiEvent,
            { type: "command.result.delivered" }
          >["output"];
          if (invocation.commandId === "new") {
            const { session, created } = await createOrReuseClientSession(
              backend,
              clientViews,
              request.clientId,
              input.permissionEpoch,
              newOptions?.reuseInactiveEmptySessions
                ? { reuseInactiveEmpty: { excludeSessionIds: [] } }
                : undefined,
            );
            selectedId = session.id;
            output = {
              kind: "data",
              subject: created ? "session.created" : "session.current",
              data: { session },
            };
          } else {
            // Missing resume arguments were rejected above; preserve every accepted flag spelling.
            if (sessionId === undefined)
              throw new Error("Resume session is required");
            selectedId = sessionId;
            await selectPermissionSession(
              backend,
              clientViews,
              request.clientId,
              selectedId,
              input.permissionEpoch,
            );
            output = {
              kind: "data",
              subject: "session.current",
              data: { sessionId: selectedId },
            };
          }
          input.emitCommandEvent({
            type: "command.result.delivered",
            ...identity,
            timestamp: Date.now(),
            output,
          });
          input.emitCommandEvent({
            type: "command.result.delivered",
            ...identity,
            timestamp: Date.now(),
            action: {
              kind: "session.selected",
              data: {
                choiceId: selectedId,
                ...(invocation.commandId === "new" ? { source: "new" } : {}),
              },
            },
          });
        } catch (error) {
          input.emitCommandEvent({
            type: "command.failed",
            ...identity,
            timestamp: Date.now(),
            error: {
              code: "EXECUTION_ERROR",
              message: error instanceof Error ? error.message : String(error),
              recoverable: true,
            },
          });
        }
        return undefined;
      }
      return backend.executeCommand(invocation);
    }
    case "respondPermission":
      return respondPermissionForClient(
        backend,
        clientViews,
        request.clientId,
        request.params[0] as string,
        request.params[1] as Parameters<
          UiBackendClient["respondPermission"]
        >[1],
        parsePermissionBinding(request.params[2]),
        input.permissionEpoch,
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
    case "abortRun": {
      const runId = request.params[0];
      if (typeof runId !== "string" || !runId)
        throw Object.assign(new Error("An exact runId is required"), {
          code: "INVALID_SESSION_QUERY",
        });
      return abortForClient({
        backend,
        views: clientViews,
        clientId: request.clientId,
        epoch: input.permissionEpoch,
        query: parseSessionQuery(request.params[1]),
        runId,
      });
    }
  }
}

export function createDaemonRpcSuccessResponse(
  request: DaemonRpcRequest,
  result: unknown,
): DaemonRpcResponse {
  return createDaemonRpcSuccess(request.id, result);
}
