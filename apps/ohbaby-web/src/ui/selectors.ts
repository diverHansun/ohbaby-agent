import type {
  UiContextWindowUsage,
  UiMessage,
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionRequest,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSnapshot,
} from "ohbaby-sdk";
import type { ConnectionState, StoreSnapshot } from "../api/daemon/wire.js";
import type { CommandNotice } from "../api/daemon/wire.js";

export interface HeaderModel {
  readonly connectionKind:
    | "idle"
    | "running"
    | "connecting"
    | "reconnecting"
    | "resyncing"
    | "disconnected";
  readonly contextLabel: string;
  readonly contextRatio: number;
  readonly modelLabel: string;
}

export interface ComposerModel {
  readonly activeRunId?: string;
  readonly activeSessionId?: string;
  readonly canSend: boolean;
  readonly canStop: boolean;
  readonly disabled: boolean;
  readonly hint: string;
  readonly isRunning: boolean;
  readonly mode: UiPermissionMode;
  readonly permissionLevel: UiPermissionLevel;
}

export interface ViewModel {
  readonly activeSession: UiSession | null;
  readonly commandCatalogVersion: string | null;
  readonly commandNotices: readonly CommandNotice[];
  readonly composer: ComposerModel;
  readonly error: string | null;
  readonly header: HeaderModel;
  readonly isEmpty: boolean;
  readonly pendingPermissions: readonly UiPermissionRequest[];
  readonly snapshot: UiSnapshot | null;
}

const DEFAULT_MODE: UiPermissionMode = "auto";
const DEFAULT_PERMISSION_LEVEL: UiPermissionLevel = "default";

export function selectViewModel(snapshot: StoreSnapshot): ViewModel {
  const daemonSnapshot = snapshot.view.snapshot;
  const activeSession = selectActiveSession(daemonSnapshot);
  const activeRun = selectActiveRun(daemonSnapshot, activeSession?.id);
  const runStatus = daemonSnapshot?.status ?? { kind: "idle" };
  const isRunning =
    runStatus.kind === "running" || runStatus.kind === "waiting-for-permission";
  const permission = daemonSnapshot?.permission;
  const pendingPermissions = daemonSnapshot?.permissions ?? [];
  const activeSessionId = activeSession?.id ?? daemonSnapshot?.activeSessionId;
  const activeRunId =
    runStatus.kind === "running"
      ? runStatus.runId
      : runStatus.kind === "waiting-for-permission"
        ? pendingPermissions.find(
            (request) => request.id === runStatus.requestId,
          )?.runId
        : activeRun?.id;

  return {
    activeSession,
    commandCatalogVersion: snapshot.view.commandCatalogVersion,
    commandNotices: snapshot.view.commandNotices,
    composer: {
      ...(activeRunId === undefined ? {} : { activeRunId }),
      ...(activeSessionId === undefined || activeSessionId === null
        ? {}
        : { activeSessionId }),
      canSend: snapshot.connectionState === "live" && !isRunning,
      canStop:
        snapshot.connectionState === "live" &&
        isRunning &&
        activeSessionId !== undefined &&
        activeSessionId !== null,
      disabled: snapshot.connectionState !== "live",
      hint: selectComposerHint(snapshot.connectionState, runStatus),
      isRunning,
      mode: permission?.mode ?? DEFAULT_MODE,
      permissionLevel: permission?.level ?? DEFAULT_PERMISSION_LEVEL,
    },
    error: snapshot.error,
    header: {
      connectionKind: selectConnectionKind(snapshot.connectionState, runStatus),
      ...selectContextModel(daemonSnapshot, activeSession?.id),
    },
    isEmpty: (activeSession?.messages.length ?? 0) === 0,
    pendingPermissions,
    snapshot: daemonSnapshot,
  };
}

export function selectActiveSession(
  snapshot: UiSnapshot | null,
): UiSession | null {
  if (!snapshot) {
    return null;
  }
  if (snapshot.activeSessionId === null) {
    return null;
  }
  return (
    snapshot.sessions.find((session) => session.id === snapshot.activeSessionId) ??
    null
  );
}

export function messageText(message: UiMessage): string {
  return message.parts
    .map((part) =>
      part.type === "text" || part.type === "reasoning" ? part.text : "",
    )
    .join("");
}

function selectActiveRun(
  snapshot: UiSnapshot | null,
  sessionId: string | undefined,
): UiRun | undefined {
  return snapshot?.runs.find((run) =>
    sessionId === undefined
      ? run.status.kind === "running"
      : run.sessionId === sessionId,
  );
}

function selectConnectionKind(
  connectionState: ConnectionState,
  status: UiRunStatus,
): HeaderModel["connectionKind"] {
  if (connectionState !== "live") {
    return connectionState;
  }
  return status.kind === "running" || status.kind === "waiting-for-permission"
    ? "running"
    : "idle";
}

function selectComposerHint(
  connectionState: ConnectionState,
  status: UiRunStatus,
): string {
  if (connectionState === "connecting") {
    return "opening session";
  }
  if (connectionState === "reconnecting") {
    return "reconnecting";
  }
  if (connectionState === "resyncing") {
    return "resyncing";
  }
  if (connectionState === "disconnected") {
    return "reload after restarting serve";
  }
  return status.kind === "running" || status.kind === "waiting-for-permission"
    ? "double click esc to stop"
    : "enter to send";
}

function selectContextModel(
  snapshot: UiSnapshot | null,
  sessionId: string | undefined,
): Omit<HeaderModel, "connectionKind"> {
  const usage = selectContextUsage(snapshot, sessionId);
  if (!usage) {
    return {
      contextLabel: "0 / 0",
      contextRatio: 0,
      modelLabel: "model pending",
    };
  }
  return {
    contextLabel: `${compactNumber(usage.currentTokens)} / ${compactNumber(
      usage.contextWindowTokens,
    )}`,
    contextRatio: clamp01(usage.contextWindowRatio),
    modelLabel: usage.modelId,
  };
}

function selectContextUsage(
  snapshot: UiSnapshot | null,
  sessionId: string | undefined,
): UiContextWindowUsage | undefined {
  if (!snapshot?.contextWindowUsages?.length) {
    return undefined;
  }
  return (
    snapshot.contextWindowUsages.find(
      (usage) => usage.sessionId === sessionId,
    ) ?? snapshot.contextWindowUsages[0]
  );
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${String(Math.round(value / 100_000) / 10)}m`;
  }
  if (value >= 1_000) {
    return `${String(Math.round(value / 100) / 10)}k`;
  }
  return String(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
