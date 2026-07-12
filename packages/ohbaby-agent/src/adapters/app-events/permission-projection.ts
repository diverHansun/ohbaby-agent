import type {
  UiEvent,
  UiPermissionRequest,
  UiRunStatus,
  UiSnapshot,
} from "ohbaby-sdk";
import type { BusInstance, BusUnsubscribe } from "../../bus/index.js";
import {
  isRememberablePermissionPattern,
  PermissionEvent,
  type PermissionInfo,
} from "../../permission/index.js";
import type { UiStateStore } from "../ui-state/index.js";

export type UiPermissionState = NonNullable<UiSnapshot["permission"]>;

export interface StartPermissionEventProjectionOptions {
  readonly bus: BusInstance;
  readonly currentPermissionState: () => UiPermissionState;
  readonly getActiveRunId: (sessionId?: string) => string | undefined;
  readonly now: () => number;
  readonly pendingPermissionSessions: Map<string, string>;
  readonly publish: (event: UiEvent) => void;
  readonly reconcileRuntimeStatus: () => Promise<UiRunStatus>;
  readonly stateStore: Pick<
    UiStateStore,
    "upsertPermission" | "removePermission"
  >;
  readonly onAsyncError?: (error: unknown) => void;
}

export function toUiPermissionRequest(input: {
  readonly info: PermissionInfo;
  readonly runId: string;
}): UiPermissionRequest {
  const allowAlways =
    input.info.metadata.rememberable !== false &&
    isRememberablePermissionPattern(input.info.pattern);
  return {
    choices: [
      { id: "allow_once", label: "Allow once", intent: "allow" },
      ...(allowAlways
        ? [
            {
              id: "allow_always",
              label: "Always allow",
              intent: "allow",
            } as const,
          ]
        : []),
      { id: "reject", label: "Reject", intent: "deny" },
      { id: "cancel", label: "Cancel run", intent: "abort" },
    ],
    description: input.info.pattern,
    id: input.info.id,
    runId: input.runId,
    title: input.info.title,
  };
}

export function startPermissionEventProjection(
  options: StartPermissionEventProjectionOptions,
): BusUnsubscribe {
  const unsubscribers = [
    options.bus.subscribe(PermissionEvent.ModeChanged, () => {
      publishPermissionUpdated(options);
    }),
    options.bus.subscribe(PermissionEvent.LevelChanged, () => {
      publishPermissionUpdated(options);
    }),
    options.bus.subscribe(PermissionEvent.RuleAdded, () => {
      publishPermissionUpdated(options);
    }),
    options.bus.subscribe(PermissionEvent.Updated, (payload) => {
      runAsyncProjection(options, async () => {
        const info = payload.info;
        const request = toUiPermissionRequest({
          info,
          // Legacy fallback: before run ownership is moved to the bus, no active
          // run stores callId in the request runId field for compatibility only.
          runId: options.getActiveRunId(info.sessionId) ?? info.callId,
        });
        options.pendingPermissionSessions.set(info.id, info.sessionId);
        await options.stateStore.upsertPermission(request);
        await options.reconcileRuntimeStatus();
        options.publish({
          request,
          timestamp: options.now(),
          type: "permission.requested",
        });
      });
    }),
    options.bus.subscribe(PermissionEvent.Replied, (payload) => {
      runAsyncProjection(options, async () => {
        options.pendingPermissionSessions.delete(payload.permissionId);
        await options.stateStore.removePermission(payload.permissionId);
        options.publish({
          requestId: payload.permissionId,
          timestamp: options.now(),
          type: "permission.resolved",
        });
        await options.reconcileRuntimeStatus();
      });
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  };
}

function publishPermissionUpdated(
  options: StartPermissionEventProjectionOptions,
): void {
  options.publish({
    permission: options.currentPermissionState(),
    timestamp: options.now(),
    type: "permission.updated",
  });
}

function runAsyncProjection(
  options: StartPermissionEventProjectionOptions,
  project: () => Promise<void>,
): void {
  void project().catch((error: unknown) => {
    options.onAsyncError?.(error);
  });
}
