import type { UiEvent, UiSnapshot } from "ohbaby-sdk";

interface ActivePromptClient {
  readonly clientId: string;
  readonly targetSessionId?: string;
  released: boolean;
}

type PermissionRequestedEvent = Extract<
  UiEvent,
  { readonly type: "permission.requested" }
>;

type RunUpdatedEvent = Extract<UiEvent, { readonly type: "run.updated" }>;
type PermissionResolvedEvent = Extract<
  UiEvent,
  { readonly type: "permission.resolved" }
>;

function isPermissionRequestedEvent(
  event: UiEvent,
): event is PermissionRequestedEvent {
  return event.type === "permission.requested";
}

function isRunUpdatedEvent(event: UiEvent): event is RunUpdatedEvent {
  return event.type === "run.updated";
}

function isPermissionResolvedEvent(
  event: UiEvent,
): event is PermissionResolvedEvent {
  return event.type === "permission.resolved";
}

export class PermissionRouter {
  private readonly activePromptClients: ActivePromptClient[] = [];
  private readonly permissionOwners = new Map<string, string>();
  private readonly runOwners = new Map<string, string>();

  trackPromptClient(clientId: string, targetSessionId?: string): () => void {
    const entry: ActivePromptClient = {
      clientId,
      released: false,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
    };
    this.activePromptClients.push(entry);

    return () => {
      entry.released = true;
      const index = this.activePromptClients.indexOf(entry);
      if (index >= 0) {
        this.activePromptClients.splice(index, 1);
      }
    };
  }

  observeEvent(event: UiEvent): void {
    if (isPermissionResolvedEvent(event)) {
      this.permissionOwners.delete(event.requestId);
      return;
    }

    if (isPermissionRequestedEvent(event)) {
      const owner = this.runOwners.get(event.request.runId);
      if (owner) {
        this.permissionOwners.set(event.request.id, owner);
      }
      return;
    }

    if (!isRunUpdatedEvent(event)) {
      return;
    }

    if (this.runOwners.has(event.run.id)) {
      this.cleanupTerminalRun(event);
      return;
    }

    const activeClient = this.promptClientForSession(event.run.sessionId);
    if (activeClient) {
      this.runOwners.set(event.run.id, activeClient);
    }
  }

  filterEventForClient(event: UiEvent, clientId: string): UiEvent | null {
    if (!isPermissionRequestedEvent(event)) {
      return event;
    }

    return this.canSeePermission(event.request.runId, clientId) ? event : null;
  }

  filterSnapshotForClient(snapshot: UiSnapshot, clientId: string): UiSnapshot {
    const permissions = snapshot.permissions.filter((permission) =>
      this.canSeePermission(permission.runId, clientId),
    );

    if (permissions.length === snapshot.permissions.length) {
      return snapshot;
    }

    return {
      ...snapshot,
      permissions,
    };
  }

  canRespondPermission(requestId: string, clientId: string): boolean {
    const owner = this.permissionOwners.get(requestId);
    return owner === undefined || owner === clientId;
  }

  private cleanupTerminalRun(event: RunUpdatedEvent): void {
    if (event.run.status.kind === "running") {
      return;
    }
    if (event.run.status.kind === "waiting-for-permission") {
      return;
    }
    this.runOwners.delete(event.run.id);
  }

  private promptClientForSession(sessionId: string): string | undefined {
    for (const entry of this.activePromptClients) {
      if (!entry.released && entry.targetSessionId === sessionId) {
        return entry.clientId;
      }
    }

    for (const entry of this.activePromptClients) {
      if (!entry.released && entry.targetSessionId === undefined) {
        return entry.clientId;
      }
    }
    return undefined;
  }

  private canSeePermission(runId: string, clientId: string): boolean {
    const owner = this.runOwners.get(runId);
    return owner === undefined || owner === clientId;
  }
}
