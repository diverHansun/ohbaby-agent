import type {
  UiMessage,
  UiPermissionRequest,
  UiRun,
  UiRunStatus,
  UiSnapshot,
  UiSession,
} from "ohbaby-sdk";
import type { UiStateStore } from "./types.js";

interface MutableUiSnapshot {
  sessions: UiSession[];
  activeSessionId: string | null;
  runs: UiRun[];
  permissions: UiPermissionRequest[];
  status: UiRunStatus;
}

export function cloneMessage(message: UiMessage): UiMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  };
}

export function cloneSession(session: UiSession): UiSession {
  return {
    ...session,
    messages: session.messages.map(cloneMessage),
  };
}

export function cloneRun(run: UiRun): UiRun {
  return {
    ...run,
    status: { ...run.status },
  };
}

export function cloneSnapshot(
  snapshot: UiSnapshot | MutableUiSnapshot,
): UiSnapshot {
  return {
    sessions: snapshot.sessions.map(cloneSession),
    activeSessionId: snapshot.activeSessionId,
    runs: snapshot.runs.map(cloneRun),
    permissions: snapshot.permissions.map((permission) => ({
      ...permission,
      choices: permission.choices.map((choice) => ({ ...choice })),
    })),
    status: { ...snapshot.status },
  };
}

function toMutableSnapshot(snapshot: UiSnapshot): MutableUiSnapshot {
  return {
    sessions: snapshot.sessions.map(cloneSession),
    activeSessionId: snapshot.activeSessionId,
    runs: snapshot.runs.map(cloneRun),
    permissions: snapshot.permissions.map((permission) => ({
      ...permission,
      choices: permission.choices.map((choice) => ({ ...choice })),
    })),
    status: { ...snapshot.status },
  };
}

export function createInMemoryUiStateStore(
  initialSnapshot: UiSnapshot,
): UiStateStore {
  const snapshot = toMutableSnapshot(initialSnapshot);

  return {
    readSnapshot(): Promise<UiSnapshot> {
      return Promise.resolve(cloneSnapshot(snapshot));
    },

    getSession(sessionId: string): Promise<UiSession | undefined> {
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      return Promise.resolve(session ? cloneSession(session) : undefined);
    },

    upsertSession(session: UiSession): Promise<void> {
      const clonedSession = cloneSession(session);
      const existingIndex = snapshot.sessions.findIndex(
        (item) => item.id === clonedSession.id,
      );
      if (existingIndex === -1) {
        snapshot.sessions = [...snapshot.sessions, clonedSession];
      } else {
        snapshot.sessions = snapshot.sessions.map((item, index) =>
          index === existingIndex ? clonedSession : item,
        );
      }
      return Promise.resolve();
    },

    setActiveSessionId(sessionId: string | null): Promise<void> {
      snapshot.activeSessionId = sessionId;
      return Promise.resolve();
    },

    addRun(run: UiRun): Promise<void> {
      snapshot.runs = [...snapshot.runs, cloneRun(run)];
      return Promise.resolve();
    },

    updateRun(run: UiRun): Promise<void> {
      const clonedRun = cloneRun(run);
      snapshot.runs = snapshot.runs.map((item) =>
        item.id === clonedRun.id ? clonedRun : item,
      );
      return Promise.resolve();
    },

    upsertPermission(request: UiPermissionRequest): Promise<void> {
      const clonedRequest = {
        ...request,
        choices: request.choices.map((choice) => ({ ...choice })),
      };
      const existingIndex = snapshot.permissions.findIndex(
        (item) => item.id === clonedRequest.id,
      );
      if (existingIndex === -1) {
        snapshot.permissions = [...snapshot.permissions, clonedRequest];
      } else {
        snapshot.permissions = snapshot.permissions.map((item, index) =>
          index === existingIndex ? clonedRequest : item,
        );
      }
      return Promise.resolve();
    },

    removePermission(requestId: string): Promise<void> {
      snapshot.permissions = snapshot.permissions.filter(
        (request) => request.id !== requestId,
      );
      return Promise.resolve();
    },

    setStatus(status: UiRunStatus): Promise<void> {
      snapshot.status = { ...status };
      return Promise.resolve();
    },
  };
}
