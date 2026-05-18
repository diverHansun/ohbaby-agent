import type {
  UiPermissionRequest,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSnapshot,
} from "ohbaby-sdk";

export interface UiStateStore {
  readonly requiresServiceManagersForWrites?: boolean;
  hasRun?(runId: string): Promise<boolean>;
  readSnapshot(): Promise<UiSnapshot>;
  getSession(sessionId: string): Promise<UiSession | undefined>;
  upsertSession(session: UiSession): Promise<void>;
  setActiveSessionId(sessionId: string | null): Promise<void>;
  addRun(run: UiRun): Promise<void>;
  updateRun(run: UiRun): Promise<void>;
  upsertPermission(request: UiPermissionRequest): Promise<void>;
  removePermission(requestId: string): Promise<void>;
  setStatus(status: UiRunStatus): Promise<void>;
}
