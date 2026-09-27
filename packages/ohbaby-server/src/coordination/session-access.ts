import type {
  UiBackendClient,
  UiPermissionBinding,
  UiPromptReceiptQuery,
  UiPromptReceiptResult,
  UiSessionControl,
  UiSessionHistory,
  UiSessionRecoveryClient,
  UiSessionScope,
  UiSessionView,
} from "ohbaby-sdk";
import type { DaemonClientViewCoordinator } from "./client-view.js";
import { permissionError, validateRoot } from "./permission-access.js";

export function sessionRecoveryCapability(
  backend: UiBackendClient,
  epoch: string,
): { runtimeEpoch: string; sessionRecoveryVersion: number } {
  return {
    runtimeEpoch: epoch,
    sessionRecoveryVersion: [
      backend.getSessionView,
      backend.getSessionHistory,
      backend.getSessionControl,
      backend.getPromptReceipt,
    ].every((method) => typeof method === "function")
      ? 1
      : 0,
  };
}
function requiredSource(backend: UiBackendClient): UiSessionRecoveryClient {
  if (sessionRecoveryCapability(backend, "").sessionRecoveryVersion !== 1)
    throw Object.assign(
      new Error("Backend does not support source session recovery"),
      { code: "SESSION_RECOVERY_UNSUPPORTED" },
    );
  return backend as UiBackendClient & UiSessionRecoveryClient;
}
export function parseSessionQuery(
  value: unknown,
  receipt = false,
): UiSessionScope &
  UiPromptReceiptQuery & { readonly before?: string; readonly limit?: number } {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  if (
    typeof input.runtimeEpoch !== "string" ||
    input.runtimeEpoch.length === 0 ||
    !Number.isSafeInteger(input.bindingGeneration) ||
    (input.bindingGeneration as number) < 1 ||
    (!receipt && (typeof input.sessionId !== "string" || !input.sessionId)) ||
    (input.sessionId !== undefined &&
      (typeof input.sessionId !== "string" || !input.sessionId)) ||
    (receipt &&
      (typeof input.clientRequestId !== "string" || !input.clientRequestId)) ||
    (input.before !== undefined &&
      (typeof input.before !== "string" || input.before.length > 4096)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 200))
  )
    throw Object.assign(
      new Error("Invalid session recovery query or missing binding"),
      { code: "INVALID_SESSION_QUERY" },
    );
  return input as unknown as UiSessionScope &
    UiPromptReceiptQuery & { before?: string; limit?: number };
}
interface Access {
  readonly backend: UiBackendClient;
  readonly views: DaemonClientViewCoordinator;
  readonly clientId: string;
  readonly epoch: string;
}
function capture(
  input: Access,
  query: { runtimeEpoch?: string; bindingGeneration?: number },
): UiPermissionBinding {
  const binding = input.views.binding(input.clientId, input.epoch);
  if (
    query.runtimeEpoch !== binding.permissionEpoch ||
    query.bindingGeneration !== binding.bindingGeneration
  )
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "Session binding has changed",
    );
  return binding;
}
function recheck(input: Access, binding: UiPermissionBinding): void {
  try {
    input.views.assertBinding(input.clientId, binding, input.epoch);
  } catch {
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "Session binding has changed",
    );
  }
}
export async function sessionReadForClient(
  input: Access & {
    readonly query: UiSessionScope & {
      readonly before?: string;
      readonly limit?: number;
    };
    readonly kind: "getSessionView" | "getSessionHistory" | "getSessionControl";
  },
): Promise<UiSessionView | UiSessionHistory | UiSessionControl> {
  const source = requiredSource(input.backend);
  const binding = capture(input, input.query);
  if (binding.rootSessionId !== input.query.sessionId)
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "Recovery is restricted to the selected root session",
    );
  await validateRoot(input.backend, input.query.sessionId);
  recheck(input, binding);
  const result = await source[input.kind](input.query);
  recheck(input, binding);
  await validateRoot(input.backend, input.query.sessionId);
  recheck(input, binding);
  const version = "version" in result ? result.version : result;
  if (
    version.runtimeEpoch !== input.epoch ||
    version.sessionId !== input.query.sessionId ||
    ("rootSessionId" in result &&
      result.rootSessionId !== input.query.sessionId)
  )
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "Source returned another session or runtime",
    );
  return { ...result, bindingGeneration: binding.bindingGeneration };
}
export async function receiptForClient(
  input: Access & { readonly query: UiPromptReceiptQuery },
): Promise<UiPromptReceiptResult> {
  const source = requiredSource(input.backend);
  const binding = capture(input, input.query);
  // Receipt recovery may refer to the original root after the UI has selected another.
  // Its authorization is the registered workspace and validated root, never the request ID.
  if (input.query.sessionId !== undefined)
    await validateRoot(input.backend, input.query.sessionId);
  recheck(input, binding);
  const result = await source.getPromptReceipt(input.query);
  recheck(input, binding);
  if (
    result.runtimeEpoch !== input.epoch ||
    result.clientRequestId !== input.query.clientRequestId ||
    (result.receipt &&
      result.receipt.clientRequestId !== input.query.clientRequestId) ||
    (result.receipt &&
      input.query.sessionId !== undefined &&
      result.receipt.sessionId !== input.query.sessionId)
  )
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "Receipt does not match its query scope",
    );
  if (result.receipt)
    await validateRoot(input.backend, result.receipt.sessionId);
  recheck(input, binding);
  return { ...result, bindingGeneration: binding.bindingGeneration };
}
export async function abortForClient(
  input: Access & { readonly query: UiSessionScope; readonly runId: string },
): Promise<void> {
  const binding = capture(input, input.query);
  const control = (await sessionReadForClient({
    ...input,
    kind: "getSessionControl",
  })) as UiSessionControl;
  recheck(input, binding);
  if (control.runId !== input.runId)
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "The requested run is no longer the selected session's active run",
    );
  // Older backend implementations may return a boolean instead of rejecting.
  const abort: (runId: string) => Promise<unknown> =
    input.backend.abortRun.bind(input.backend);
  const result = await abort(input.runId);
  if (result === false)
    throw permissionError(
      "SESSION_SCOPE_CHANGED",
      "The requested run has already ended",
    );
}

/** A shared operation for REST, RPC and /new; index data stays separate from its outcome. */
export function createOrReuseClientSession(
  backend: Pick<UiBackendClient, "createSession">,
  views: DaemonClientViewCoordinator,
  clientId: string,
  epoch: string,
  options?: Parameters<UiBackendClient["createSession"]>[0],
): Promise<{
  session: Awaited<ReturnType<UiBackendClient["createSession"]>>;
  binding: UiPermissionBinding;
  changed: boolean;
  created: boolean;
}> {
  const previous = views.binding(clientId, epoch);
  if (
    options?.reuseSessionId &&
    options.reuseSessionId !== previous.rootSessionId
  )
    return Promise.reject(
      permissionError(
        "PERMISSION_SCOPE_CHANGED",
        "Reuse is restricted to the selected root session",
      ),
    );
  const key = JSON.stringify([clientId, previous, options ?? null]);
  return views.shareSessionCreation(key, async () => {
    const release = views.beginSessionOperation(clientId);
    const reuse = Boolean(
      options?.reuseSessionId ?? options?.reuseInactiveEmpty,
    );
    const excluded = new Set(
      options?.reuseInactiveEmpty?.excludeSessionIds ?? [],
    );
    try {
      for (let attempt = 0; attempt <= 3; attempt += 1) {
        views.assertBinding(clientId, previous, epoch);
        const protectedIds = views.protectedSessionIds();
        const exclusions = new Set([
          ...excluded,
          ...views.sessionIdsBoundByOtherClients(clientId),
          ...protectedIds,
        ]);
        const preferred =
          previous.rootSessionId &&
          !protectedIds.includes(previous.rootSessionId) &&
          !excluded.has(previous.rootSessionId)
            ? previous.rootSessionId
            : undefined;
        const revision = views.sessionAdmissionRevision;
        const session = await backend.createSession(
          reuse
            ? {
                ...(preferred ? { reuseSessionId: preferred } : {}),
                ...(options?.reuseInactiveEmpty
                  ? {
                      reuseInactiveEmpty: {
                        excludeSessionIds: [...exclusions],
                      },
                    }
                  : {}),
              }
            : undefined,
        );
        views.assertBinding(clientId, previous, epoch);
        const created = session.created;
        if (reuse && typeof created !== "boolean")
          throw Object.assign(
            new Error(
              "Backend must report whether a reused session was created",
            ),
            { code: "SESSION_CREATION_CONTRACT" },
          );
        if (reuse && session.id !== preferred && exclusions.has(session.id))
          throw Object.assign(
            new Error("Backend returned an excluded session"),
            { code: "SESSION_CREATION_CONTRACT" },
          );
        const changed = session.id !== previous.rootSessionId;
        if (
          reuse &&
          (revision !== views.sessionAdmissionRevision ||
            views.protectedSessionIds().includes(session.id) ||
            (changed &&
              views
                .sessionIdsBoundByOtherClients(clientId)
                .includes(session.id)))
        ) {
          // Do not create a second row after a fresh result lost its admission window.
          if (created) throw sessionCreationConflict();
          // A started-and-finished admission can be absent from the pin set: re-read its persisted facts.
          if (
            views.sessionIdsBoundByOtherClients(clientId).includes(session.id)
          )
            excluded.add(session.id);
          continue;
        }
        if (changed)
          views.selectSession(clientId, session.id, previous.bindingGeneration);
        return {
          session,
          binding: views.binding(clientId, epoch),
          changed,
          created: created ?? true,
        };
      }
      throw sessionCreationConflict();
    } finally {
      release();
    }
  });
}

export function parseSessionCreationOptions(
  value: unknown,
): Parameters<UiBackendClient["createSession"]>[0] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("Invalid session creation options"), {
      code: "INVALID_SESSION_QUERY",
    });
  const input = value as Record<string, unknown>;
  const inactive = input.reuseInactiveEmpty;
  if (
    input.reuseSessionId !== undefined &&
    (typeof input.reuseSessionId !== "string" || !input.reuseSessionId)
  )
    throw Object.assign(new Error("Invalid preferred session"), {
      code: "INVALID_SESSION_QUERY",
    });
  let excludeSessionIds: string[] | undefined;
  if (inactive !== undefined) {
    if (
      !inactive ||
      typeof inactive !== "object" ||
      Array.isArray(inactive) ||
      !("excludeSessionIds" in inactive) ||
      !Array.isArray(inactive.excludeSessionIds) ||
      !inactive.excludeSessionIds.every(
        (id: unknown) => typeof id === "string" && id.length > 0,
      )
    )
      throw Object.assign(new Error("Invalid session exclusions"), {
        code: "INVALID_SESSION_QUERY",
      });
    excludeSessionIds = inactive.excludeSessionIds as string[];
  }
  return {
    ...(typeof input.reuseSessionId === "string"
      ? { reuseSessionId: input.reuseSessionId }
      : {}),
    ...(excludeSessionIds ? { reuseInactiveEmpty: { excludeSessionIds } } : {}),
  };
}

function sessionCreationConflict(): Error {
  return Object.assign(
    new Error("Session changed during creation; retry the request"),
    {
      code: "SESSION_CREATION_CONFLICT",
      retryable: true,
    },
  );
}
