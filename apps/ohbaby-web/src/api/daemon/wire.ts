import type {
  UiEvent,
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionResponse,
  UiPermissionState,
  UiSnapshot,
} from "ohbaby-sdk";

export interface WebStartupIntent {
  readonly startupSessionMode?: { readonly type: "continue" | "fresh" };
  readonly resumeSessionId?: string;
  readonly initialPermission?: {
    readonly level: "default" | "full-access";
    readonly mode: "plan" | "auto";
  };
}

export interface OhbabyBootstrapConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly startupIntent?: WebStartupIntent;
  readonly token: string;
}

export type ConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "resyncing"
  | "disconnected";

export interface ViewState {
  readonly lastAppliedSeqNum: number;
  readonly snapshot: UiSnapshot | null;
}

export interface StoreSnapshot {
  readonly connectionState: ConnectionState;
  readonly error: string | null;
  readonly view: ViewState;
}

export interface RegisterClientResponse {
  readonly clientId: string;
  readonly ok: true;
}

export interface SnapshotResponse {
  readonly ok: true;
  readonly seqNum: number;
  readonly snapshot: UiSnapshot;
}

export interface PromptAcceptedResponse {
  readonly ok: true;
  readonly sessionId?: string;
}

export interface OkResponse {
  readonly ok: true;
}

export interface PermissionStateResponse {
  readonly ok: true;
  readonly permission: UiPermissionState;
}

export type WebSseEvent =
  | {
      readonly type: "hello";
      readonly clientId: string;
    }
  | {
      readonly type: "ui.event";
      readonly event: UiEvent;
    }
  | {
      readonly type: "resync-required";
      readonly maxSeqNum: number;
      readonly minSeqNum: number;
    }
  | {
      readonly type: "error";
      readonly message: string;
    };

export interface SubmitPromptRequest {
  readonly sessionId?: string;
  readonly text: string;
}

export interface SetPermissionRequest {
  readonly level?: UiPermissionLevel;
  readonly mode?: UiPermissionMode;
}

export type PermissionResponseRequest =
  | UiPermissionResponse
  | { readonly response: UiPermissionResponse };
