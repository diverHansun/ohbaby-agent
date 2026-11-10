import type { UiEvent, UiPermissionState, UiSnapshot } from "ohbaby-sdk";

export function permissionStateForRoot(
  state: UiPermissionState,
  rootSessionId: string | null,
): UiPermissionState {
  return {
    ...state,
    sessionRules: state.sessionRules.filter(
      (entry) => entry.sessionId === rootSessionId,
    ),
  };
}

export function isPermissionEvent(event: UiEvent): boolean {
  return (
    event.type === "permission.requested" ||
    event.type === "permission.resolved" ||
    event.type === "permission.unavailable"
  );
}

/** Permission routing follows the authenticated client's selected root. */
export class PermissionRouter {
  filterEventForClient(
    event: UiEvent,
    rootSessionId: string | null,
  ): UiEvent | null {
    if (event.type === "permission.updated") {
      if (event.sessionId !== undefined && event.sessionId !== rootSessionId)
        return null;
      return {
        ...event,
        permission: permissionStateForRoot(event.permission, rootSessionId),
        ...(event.previousPermission && {
          previousPermission: permissionStateForRoot(
            event.previousPermission,
            rootSessionId,
          ),
        }),
      };
    }
    if (event.type === "permission.unavailable")
      return event.rootSessionId === null ||
        event.rootSessionId === rootSessionId
        ? event
        : null;
    if (
      event.type === "permission.requested" ||
      event.type === "permission.resolved"
    )
      return rootSessionId !== null && event.rootSessionId === rootSessionId
        ? event
        : null;
    return event;
  }

  filterSnapshotForClient(
    snapshot: UiSnapshot,
    rootSessionId: string | null,
  ): UiSnapshot {
    return {
      ...snapshot,
      ...(snapshot.permission && {
        permission: permissionStateForRoot(snapshot.permission, rootSessionId),
      }),
      permissions: snapshot.permissions.filter(
        (permission) =>
          rootSessionId !== null && permission.rootSessionId === rootSessionId,
      ),
    };
  }
}
