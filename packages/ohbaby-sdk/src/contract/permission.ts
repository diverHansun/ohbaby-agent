import type { UiPermissionRequest } from "./snapshot.js";

export interface UiPermissionBinding {
  readonly permissionEpoch: string;
  readonly rootSessionId: string | null;
  readonly bindingGeneration: number;
}

export interface UiPermissionSnapshot {
  readonly permissionEpoch: string;
  readonly rootSessionId: string | null;
  readonly permissionRevision: number;
  readonly requests: readonly UiPermissionRequest[];
  readonly bindingGeneration?: number;
}

export interface UiPermissionSnapshotQuery {
  readonly rootSessionId: string | null;
  readonly permissionEpoch?: string;
  readonly bindingGeneration?: number;
  readonly signal?: AbortSignal;
}

export interface UiPermissionResponseContext {
  readonly rootSessionId: string | null;
  readonly permissionEpoch: string;
  readonly bindingGeneration?: number;
}

export interface UiSessionIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly projectRoot?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentId?: string;
  readonly isSubagent?: boolean;
}

export interface UiPermissionRequestedEvent {
  readonly type: "permission.requested";
  readonly permissionEpoch: string;
  readonly rootSessionId: string;
  readonly permissionRevision: number;
  readonly bindingGeneration?: number;
  readonly request: UiPermissionRequest;
  readonly timestamp?: number;
}

export interface UiPermissionResolvedEvent {
  readonly type: "permission.resolved";
  readonly permissionEpoch: string;
  readonly rootSessionId: string;
  readonly permissionRevision: number;
  readonly bindingGeneration?: number;
  readonly requestId: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly timestamp?: number;
}

export interface UiPermissionUnavailableEvent {
  readonly type: "permission.unavailable";
  readonly permissionEpoch: string;
  readonly rootSessionId: string | null;
  readonly reason: string;
  readonly bindingGeneration?: number;
  readonly timestamp?: number;
}

export interface UiPermissionResyncRequiredEvent {
  readonly type: "permission.resync-required";
  readonly permissionEpoch: string;
  readonly rootSessionId: string | null;
  readonly bindingGeneration?: number;
  readonly connectionGeneration?: number;
  readonly timestamp?: number;
}

export type UiPermissionEvent =
  | UiPermissionRequestedEvent
  | UiPermissionResolvedEvent
  | UiPermissionUnavailableEvent
  | UiPermissionResyncRequiredEvent;
