import {
  inferConnectModelInterfaceProvider,
  isConnectModelInterfaceProvider,
  SESSION_MOVED_ERROR_CODE,
  type UiBackendClient,
  type UiPermissionResponse,
  type UiSlashCommandInvocation,
  type UiSnapshot,
} from "ohbaby-sdk";
import { isDaemonForbiddenError } from "../../coordination/client-view.js";
import { PermissionRouter } from "../../coordination/permission-router.js";
import {
  createDaemonRpcFailure,
  type DaemonStartupIntent,
} from "../jsonrpc/protocol.js";

export const CLIENT_ID_HEADER = "x-ohbaby-client-id";

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export const DEFAULT_WEB_STARTUP_INTENT: DaemonStartupIntent = {
  startupSessionMode: { type: "fresh" },
};

export function unauthorizedBody(id = "unknown"): unknown {
  return createDaemonRpcFailure(id, new Error("Unauthorized"));
}

export function requestTooLargeBody(): unknown {
  return createDaemonRpcFailure(
    "unknown",
    new Error("Request body is too large"),
  );
}

export function webErrorBody(message: string): unknown {
  return { error: { message }, ok: false };
}

export function promptRejectionBody(message: string): unknown {
  return { error: { code: "PROMPT_SUBMISSION_REJECTED", message }, ok: false };
}

/** An unclassified admission error can occur after the durable receipt was saved. */
export function promptAdmissionStatus(error: unknown): 400 | 409 | 429 | 500 {
  const code = isRecord(error) ? error.code : undefined;
  if (code === "QUEUE_FULL") return 429;
  if (code === "IDEMPOTENCY_CONFLICT" || code === SESSION_MOVED_ERROR_CODE)
    return 409;
  if (
    code === "PROMPT_SUBMISSION_REJECTED" ||
    code === "INVALID_CLIENT_REQUEST_ID" ||
    code === "PROMPT_SCHEDULER_CLOSED"
  )
    return 400;
  return 500;
}

export function promptErrorBody(error: unknown): unknown {
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

export function promptMutationStatus(
  error: unknown,
): 400 | 403 | 404 | 409 | 429 {
  if (isDaemonForbiddenError(error)) return 403;
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "QUEUE_FULL") {
    return 429;
  }
  if (code === "PROMPT_NOT_FOUND" || code === "STEER_INPUT_NOT_FOUND") {
    return 404;
  }
  if (
    code === "CURRENT_RUN_INPUT_CONFLICT" ||
    code === "STEER_INPUT_NOT_RECOVERABLE" ||
    code === "SESSION_SCOPE_CHANGED" ||
    code === SESSION_MOVED_ERROR_CODE ||
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return undefined;
  }
  return value as number;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mutationErrorStatus(error: unknown): 400 | 404 | 409 {
  const message = errorMessage(error);
  if (message.startsWith("Session not found:")) {
    return 404;
  }
  return message === "Cannot save while running" ? 409 : 400;
}

export function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length === value.length ? items : undefined;
}

export function permissionRouterSnapshotForClient(
  permissionRouter: PermissionRouter,
  snapshot: UiSnapshot,
  rootSessionId: string | null,
): UiSnapshot {
  return permissionRouter.filterSnapshotForClient(snapshot, rootSessionId);
}

export function permissionResponseFromBody(
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

export function slashCommandInvocationFromBody(
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
    ...(asNonEmptyString(value.clientRequestId)
      ? { clientRequestId: asNonEmptyString(value.clientRequestId) }
      : {}),
    path,
    raw,
    rawArgs,
    surface,
    ...(argumentMode === undefined ? {} : { argumentMode }),
    ...(body === undefined ? {} : { body }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export function modelConnectInputFromBody(
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

export function searchApiKeyInputFromBody(
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

export function scheduleAfterResponse(
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

export async function readRequestTextWithLimit(request: Request): Promise<
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

export async function readJsonWithLimit(request: Request): Promise<
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
