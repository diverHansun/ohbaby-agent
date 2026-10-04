import type {
  UiBackendClient,
  UiPermissionBinding,
  UiPermissionSnapshot,
} from "ohbaby-sdk";
import {
  DaemonForbiddenError,
  type DaemonClientViewCoordinator,
  parseDaemonStartupIntent,
} from "./client-view.js";

export function permissionError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new DaemonForbiddenError(message), { code });
}

export function parsePermissionBinding(value: unknown): UiPermissionBinding {
  if (!value || typeof value !== "object")
    throw permissionError(
      "PERMISSION_SCOPE_CHANGED",
      "Permission binding is required",
    );
  const input = value as Record<string, unknown>;
  if (
    typeof input.permissionEpoch !== "string" ||
    !input.permissionEpoch ||
    !(
      input.rootSessionId === null ||
      (typeof input.rootSessionId === "string" &&
        input.rootSessionId.length > 0)
    ) ||
    !Number.isSafeInteger(input.bindingGeneration) ||
    (input.bindingGeneration as number) < 1
  )
    throw permissionError(
      "PERMISSION_SCOPE_CHANGED",
      "Invalid permission binding",
    );
  return {
    permissionEpoch: input.permissionEpoch,
    rootSessionId: input.rootSessionId,
    bindingGeneration: input.bindingGeneration as number,
  };
}

const initializedIntents = new WeakMap<
  DaemonClientViewCoordinator,
  Map<string, string>
>();

export async function initializePermissionClient(
  backend: UiBackendClient,
  views: DaemonClientViewCoordinator,
  clientId: string,
  intent: unknown,
  epoch: string,
): Promise<UiPermissionBinding> {
  const parsedIntent = parseDaemonStartupIntent(intent);
  const intentKey = JSON.stringify(parsedIntent);
  const intents = initializedIntents.get(views) ?? new Map<string, string>();
  initializedIntents.set(views, intents);
  if (views.isRegistered(clientId) && intents.get(clientId) === intentKey)
    return views.binding(clientId, epoch);
  const attempt = views.beginRegistration(clientId);
  const previous = views.isRegistered(clientId)
    ? views.binding(clientId, epoch)
    : undefined;
  const sessions = await backend.getSessionIndex();
  views.assertRegistration(clientId, attempt);
  if (previous) views.assertBinding(clientId, previous, epoch);
  views.initializeClient(clientId, { sessions }, parsedIntent);
  intents.set(clientId, intentKey);
  const binding = views.binding(clientId, epoch);
  if (binding.rootSessionId)
    void backend
      .initializeSession?.(binding.rootSessionId)
      .catch(() => undefined);
  return binding;
}

export async function validateRoot(
  backend: UiBackendClient,
  rootSessionId: string | null,
): Promise<void> {
  if (rootSessionId === null) return;
  const index = await backend.getSessionIndex();
  const session = index.find((item) => item.id === rootSessionId);
  if (!session || session.parentId || session.isSubagent)
    throw permissionError(
      "PERMISSION_SCOPE_CHANGED",
      "Selected session is not an available root session",
    );
}

export async function selectPermissionSession(
  backend: UiBackendClient,
  views: DaemonClientViewCoordinator,
  clientId: string,
  rootSessionId: string,
  epoch: string,
  expectedGeneration?: number,
): Promise<UiPermissionBinding> {
  const finishOperation = views.beginSessionOperation(clientId, rootSessionId);
  try {
    const previous = views.binding(clientId, epoch);
    if (
      expectedGeneration !== undefined &&
      previous.bindingGeneration !== expectedGeneration
    )
      throw permissionError(
        "PERMISSION_SCOPE_CHANGED",
        "Session selection has changed",
      );
    await validateRoot(backend, rootSessionId);
    views.assertBinding(clientId, previous, epoch);
    views.selectSession(clientId, rootSessionId, previous.bindingGeneration);
    const binding = views.binding(clientId, epoch);
    if (binding.rootSessionId)
      void backend
        .initializeSession?.(binding.rootSessionId)
        .catch(() => undefined);
    return binding;
  } finally {
    finishOperation();
  }
}

export async function permissionSnapshotForClient(
  backend: UiBackendClient,
  views: DaemonClientViewCoordinator,
  clientId: string,
  expected: UiPermissionBinding,
  epoch: string,
): Promise<UiPermissionSnapshot> {
  views.assertBinding(clientId, expected, epoch);
  await validateRoot(backend, expected.rootSessionId);
  views.assertBinding(clientId, expected, epoch);
  const snapshot = await backend.getPermissionSnapshot(expected);
  views.assertBinding(clientId, expected, epoch);
  if (
    snapshot.permissionEpoch !== epoch ||
    snapshot.rootSessionId !== expected.rootSessionId
  )
    throw permissionError(
      "PERMISSION_SCOPE_CHANGED",
      "Permission runtime has changed",
    );
  return { ...snapshot, bindingGeneration: expected.bindingGeneration };
}

export async function respondPermissionForClient(
  backend: UiBackendClient,
  views: DaemonClientViewCoordinator,
  clientId: string,
  id: string,
  response: Parameters<UiBackendClient["respondPermission"]>[1],
  expected: UiPermissionBinding,
  epoch: string,
): Promise<void> {
  views.assertBinding(clientId, expected, epoch);
  await validateRoot(backend, expected.rootSessionId);
  views.assertBinding(clientId, expected, epoch);
  await backend.respondPermission(id, response, expected);
}
