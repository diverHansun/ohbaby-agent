import type { UiEvent, UiSnapshot } from "ohbaby-sdk";

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
      permissions: snapshot.permissions.filter(
        (permission) =>
          rootSessionId !== null && permission.rootSessionId === rootSessionId,
      ),
    };
  }
}
