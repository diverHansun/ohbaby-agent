import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  parseNewSessionCommandArgs,
  SessionRunBusyError,
  type UiPromptQueueExecutionPort,
} from "ohbaby-agent";
import type {
  SubmitPromptOptions,
  UiAcquirePromptEditLeaseInput,
  UiBackendClient,
  UiCancelQueuedPromptInput,
  UiEditQueuedPromptInput,
  UiEvent,
  UiReleasePromptEditLeaseInput,
  UiRenewPromptEditLeaseInput,
  UiResubmitRetainedPromptInput,
} from "ohbaby-sdk";
import { isUiPromptNamingSource, isUiReasoningConfig } from "ohbaby-sdk";
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
  acceptDaemonPrompt,
  acquirePromptEditLeaseForClient,
  cancelQueuedPromptForClient,
  editQueuedPromptForClient,
  executeCommandForClient,
  releasePromptEditLeaseForClient,
  renewPromptEditLeaseForClient,
  resendSteerInputForClient,
  resubmitRetainedPromptForClient,
  steerQueuedPromptForClient,
} from "../../coordination/prompt-backend.js";
import {
  abortForClient,
  createOrReuseClientSession,
  parseSessionCreationOptions,
  parseSessionQuery,
  receiptForClient,
  sessionReadForClient,
  sessionRecoveryCapability,
  subagentConversationReadForClient,
  subagentReadForClient,
  unwatchSubagentConversationForClient,
  watchSubagentConversationForClient,
} from "../../coordination/session-access.js";
import {
  parseSessionExportInput,
  sessionExportErrorStatus,
} from "../session-export.js";
import {
  MAX_REQUEST_BODY_BYTES,
  readRequestTextWithLimit,
  requestTooLargeBody,
  unauthorizedBody,
} from "../web/request-helpers.js";
import type { DaemonRouteContext } from "../web/routes/context.js";
import {
  createDaemonRpcFailure,
  createDaemonRpcSuccess,
  parseDaemonRpcRequest,
  type DaemonRpcRequest,
  type DaemonRpcResponse,
} from "./protocol.js";

export { MAX_REQUEST_BODY_BYTES } from "../web/request-helpers.js";

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
  if (
    value.modelEntryId !== undefined &&
    (typeof value.modelEntryId !== "string" || !value.modelEntryId.trim())
  )
    throw Object.assign(new Error("Invalid model entry id"), {
      code: "VALIDATION_FAILED",
    });
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
    ...(typeof value.modelEntryId === "string"
      ? { modelEntryId: value.modelEntryId }
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
    case "exportSession": {
      if (!clientViews.isRegistered(request.clientId)) {
        throw Object.assign(new Error("client is not registered"), {
          code: "CLIENT_NOT_REGISTERED",
        });
      }
      return backend.exportSession(parseSessionExportInput(request.params[0]));
    }
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
    case "resendSteerInput": {
      const input = request.params[0];
      if (
        !isRecord(input) ||
        typeof input.inputId !== "string" ||
        !input.inputId.trim() ||
        typeof input.operationId !== "string" ||
        !input.operationId.trim()
      ) {
        throw Object.assign(new Error("inputId and operationId are required"), {
          code: "INVALID_ARGUMENT",
        });
      }
      return resendSteerInputForClient(
        backend,
        { inputId: input.inputId, operationId: input.operationId },
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
      return backend.compactSession({
        ...(request.params[0] as Parameters<
          UiBackendClient["compactSession"]
        >[0]),
        signal: input.signal,
      });
    case "updateSessionModel": {
      const value = request.params[0];
      if (
        !isRecord(value) ||
        typeof value.sessionId !== "string" ||
        !value.sessionId.trim() ||
        (value.modelEntryId !== null &&
          (typeof value.modelEntryId !== "string" ||
            !value.modelEntryId.trim()))
      )
        throw Object.assign(new Error("Invalid session model selection"), {
          code: "VALIDATION_FAILED",
        });
      return backend.updateSessionModel({
        sessionId: value.sessionId,
        modelEntryId: value.modelEntryId,
      });
    }
    case "selectDefaultModel": {
      const entryId = request.params[0];
      if (typeof entryId !== "string" || !entryId.trim())
        throw Object.assign(new Error("Invalid model entry id"), {
          code: "VALIDATION_FAILED",
        });
      return backend.selectDefaultModel(entryId);
    }
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
    case "getCurrentModel": {
      const value = request.params[0];
      if (value === undefined) return backend.getCurrentModel();
      const nonEmpty = (field: unknown): boolean =>
        field === undefined || (typeof field === "string" && !!field.trim());
      if (
        !isRecord(value) ||
        !nonEmpty(value.sessionId) ||
        !nonEmpty(value.modelEntryId)
      )
        throw Object.assign(new Error("Invalid session or model entry id"), {
          code: "VALIDATION_FAILED",
        });
      return backend.getCurrentModel({
        ...(typeof value.sessionId === "string"
          ? { sessionId: value.sessionId }
          : {}),
        ...(typeof value.modelEntryId === "string"
          ? { modelEntryId: value.modelEntryId }
          : {}),
      });
    }
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
      try {
        if (
          invocation.commandId === "new" ||
          invocation.commandId === "resume"
        ) {
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
            return {
              ...identity,
              sessionId: invocation.sessionId,
              status: "failed",
              error: newOptions,
              outputCount: 0,
              eventCount: 1,
            };
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
            return {
              ...identity,
              sessionId: invocation.sessionId,
              status: "failed",
              error: {
                code: "SESSION_ID_REQUIRED",
                message: "Use /resume --session_id <id> to resume a session",
                recoverable: true,
              },
              outputCount: 0,
              eventCount: 1,
            };
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
            return {
              ...identity,
              sessionId: invocation.sessionId,
              status: "completed",
              outputCount: 1,
              eventCount: 2,
            };
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
            return {
              ...identity,
              sessionId: invocation.sessionId,
              status: "failed",
              error: {
                code: "EXECUTION_ERROR",
                message: error instanceof Error ? error.message : String(error),
                recoverable: true,
              },
              outputCount: 0,
              eventCount: 1,
            };
          }
        }
        const completion = await executeCommandForClient({
          backend,
          clientId: request.clientId,
          clientViews,
          createSessionId,
          permissionRouter,
          invocation,
          signal: input.signal,
        });
        return {
          ...completion,
          ...(completion.promptReceipt
            ? clientViews.binding(request.clientId, input.permissionEpoch)
            : {}),
        };
      } finally {
        clientViews.completeCommandInvocation(invocation.clientInvocationId);
      }
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

export function registerRpcRoute(app: Hono, ctx: DaemonRouteContext): void {
  app.post("/api/rpc", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
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
      ctx.clientViews.isRegistered(parsed.request.clientId)
    )
      ctx.touchClientActivity(parsed.request.clientId);
    try {
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      if (context.req.raw.signal.aborted) controller.abort();
      context.req.raw.signal.addEventListener("abort", abort, { once: true });
      ctx.waitControllers.add(controller);
      const priorGeneration = ctx.clientViews.isRegistered(
        parsed.request.clientId,
      )
        ? ctx.clientViews.binding(parsed.request.clientId, ctx.permissionEpoch)
            .bindingGeneration
        : undefined;
      try {
        const result = await callDaemonBackend({
          backend: ctx.commandBackend("server-rpc", {
            clientId: parsed.request.clientId,
            transportRequestId: parsed.request.id,
          }),
          clientViews: ctx.clientViews,
          createSessionId: ctx.createSessionId,
          permissionRouter: ctx.permissionRouter,
          permissionEpoch: ctx.permissionEpoch,
          emitCommandEvent: (event) => {
            ctx.broadcast(ctx.eventBus.publish(event));
          },
          request: parsed.request,
          signal: controller.signal,
        });
        if (parsed.request.method === "initializeClient") {
          ctx.knownClientIds.add(parsed.request.clientId);
          ctx.registeredWebClientIds.add(parsed.request.clientId);
          ctx.touchClientActivity(parsed.request.clientId);
        }
        return context.json(
          createDaemonRpcSuccessResponse(parsed.request, result),
        );
      } finally {
        if (
          ctx.clientViews.isRegistered(parsed.request.clientId) &&
          !ctx.clientViews.isPromptBindingProvisional(
            parsed.request.clientId,
          ) &&
          ctx.clientViews.binding(parsed.request.clientId, ctx.permissionEpoch)
            .bindingGeneration !== priorGeneration &&
          parsed.request.method !== "initializeClient"
        )
          ctx.notifyBinding(parsed.request.clientId);
        context.req.raw.signal.removeEventListener("abort", abort);
        ctx.waitControllers.delete(controller);
      }
    } catch (error) {
      const status =
        parsed.request.method === "archiveSession" &&
        error instanceof SessionRunBusyError
          ? 409
          : parsed.request.method === "exportSession"
            ? sessionExportErrorStatus(error)
            : isRecord(error) && error.code === "SESSION_SCOPE_CHANGED"
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
}
