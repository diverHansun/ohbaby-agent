import type {
  UiCommandAction,
  UiCommandError,
  UiCommandOutput,
} from "./command/types.js";
import type { UiInteractionRequest } from "./interaction.js";
import type {
  UiMessage,
  UiPermissionState,
  UiPermissionRequest,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSnapshot,
} from "./snapshot.js";

export interface UiSnapshotReplacedEvent {
  readonly type: "snapshot.replaced";
  readonly snapshot: UiSnapshot;
  readonly timestamp?: number;
}

export interface UiRuntimeUpdatedEvent {
  readonly type: "runtime.updated";
  readonly status: UiRunStatus;
  readonly timestamp?: number;
}

export interface UiPermissionUpdatedEvent {
  readonly type: "permission.updated";
  readonly permission: UiPermissionState;
  readonly previousPermission?: UiPermissionState;
  readonly timestamp?: number;
}

export interface UiSessionUpdatedEvent {
  readonly type: "session.updated";
  readonly session: UiSession;
  readonly timestamp?: number;
}

export interface UiMessageAppendedEvent {
  readonly type: "message.appended";
  readonly sessionId: string;
  readonly message: UiMessage;
  readonly timestamp?: number;
}

export interface UiMessageUpdatedEvent {
  readonly type: "message.updated";
  readonly sessionId: string;
  readonly message: UiMessage;
  readonly timestamp?: number;
}

export interface UiMessagePartDeltaEvent {
  readonly type: "message.part.delta";
  readonly sessionId: string;
  readonly messageId?: string;
  readonly partId?: string;
  readonly delta: string;
  readonly content?: string;
  readonly timestamp?: number;
}

export interface UiRunUpdatedEvent {
  readonly type: "run.updated";
  readonly run: UiRun;
  readonly timestamp?: number;
}

export interface UiPermissionRequestedEvent {
  readonly type: "permission.requested";
  readonly request: UiPermissionRequest;
  readonly timestamp?: number;
}

export interface UiPermissionResolvedEvent {
  readonly type: "permission.resolved";
  readonly requestId: string;
  readonly timestamp?: number;
}

export interface UiNotice {
  readonly id: string;
  readonly key?: string;
  readonly level: "info" | "warning" | "error";
  readonly title: string;
  readonly message: string;
  readonly source?: string;
  readonly createdAt: string;
}

export interface UiNoticeEmittedEvent {
  readonly type: "notice.emitted";
  readonly notice: UiNotice;
  readonly timestamp?: number;
}

export interface UiCommandStartedEvent {
  readonly type: "command.started";
  readonly command: {
    readonly commandRunId: string;
    readonly clientInvocationId: string;
    readonly commandId: string;
    readonly path: readonly string[];
    readonly surface: string;
    readonly sessionId?: string;
  };
  readonly timestamp: number;
}

export interface UiCommandResultDeliveredEvent {
  readonly type: "command.result.delivered";
  readonly commandRunId: string;
  readonly clientInvocationId: string;
  readonly output?: UiCommandOutput;
  readonly action?: UiCommandAction;
  readonly timestamp: number;
}

export interface UiCommandFailedEvent {
  readonly type: "command.failed";
  readonly commandRunId: string;
  readonly clientInvocationId: string;
  readonly error: UiCommandError;
  readonly timestamp: number;
}

export interface UiCommandCatalogUpdatedEvent {
  readonly type: "command.catalog.updated";
  readonly version: string;
  readonly reason?: string;
  readonly timestamp: number;
}

export interface UiInteractionRequestedEvent {
  readonly type: "interaction.requested";
  readonly request: UiInteractionRequest;
  readonly timestamp: number;
}

export interface UiInteractionResolvedEvent {
  readonly type: "interaction.resolved";
  readonly interactionId: string;
  readonly commandRunId: string;
  readonly clientInvocationId?: string;
  readonly status: "accepted" | "cancelled";
  readonly timestamp: number;
}

export type UiEvent =
  | UiSnapshotReplacedEvent
  | UiRuntimeUpdatedEvent
  | UiPermissionUpdatedEvent
  | UiSessionUpdatedEvent
  | UiMessageAppendedEvent
  | UiMessageUpdatedEvent
  | UiMessagePartDeltaEvent
  | UiRunUpdatedEvent
  | UiPermissionRequestedEvent
  | UiPermissionResolvedEvent
  | UiNoticeEmittedEvent
  | UiCommandStartedEvent
  | UiCommandResultDeliveredEvent
  | UiCommandFailedEvent
  | UiCommandCatalogUpdatedEvent
  | UiInteractionRequestedEvent
  | UiInteractionResolvedEvent;
