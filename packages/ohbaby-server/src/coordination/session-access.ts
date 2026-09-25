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
