import type { UiEvent, UiSnapshot } from "ohbaby-sdk";

interface ActivePromptClient {
  readonly clientId: string;
  released: boolean;
}

type PermissionRequestedEvent = Extract<
  UiEvent,
  { readonly type: "permission.requested" }
>;

type RunUpdatedEvent = Extract<UiEvent, { readonly type: "run.updated" }>;

function isPermissionRequestedEvent(
  event: UiEvent,
): event is PermissionRequestedEvent {
  return event.type === "permission.requested";
}

function isRunUpdatedEvent(event: UiEvent): event is RunUpdatedEvent {
  return event.type === "run.updated";
}

export class PermissionRouter {
  private readonly activePromptClients: ActivePromptClient[] = [];
  private readonly runOwners = new Map<string, string>();

  trackPromptClient(clientId: string): () => void {
    const entry: ActivePromptClient = { clientId, released: false };
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
    if (!isRunUpdatedEvent(event) || this.runOwners.has(event.run.id)) {
      return;
    }

    const activeClient = this.currentPromptClient();
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

  private currentPromptClient(): string | undefined {
    for (let index = this.activePromptClients.length - 1; index >= 0; index--) {
      const entry = this.activePromptClients[index];
      if (!entry.released) {
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
