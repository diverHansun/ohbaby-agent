import type {
  UiEvent,
  UiCompactSessionResult,
  UiContextWindowUsage,
  UiConnectModelResult,
  UiCurrentModelConfig,
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionResponse,
  UiPermissionState,
  UiProbeModelContextWindowResult,
  UiSetSearchApiKeyResult,
  UiWebCommandCatalog,
  UiSlashCommandInvocation,
  UiSlashCommandOutput,
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
  readonly commandNotices: readonly CommandNotice[];
  readonly commandCatalogVersion: string | null;
  readonly lastAppliedSeqNum: number;
  readonly reasoningByMessageId: Record<string, ReasoningViewState>;
  readonly snapshot: UiSnapshot | null;
}

export interface ReasoningViewState {
  readonly content: string;
  readonly folded: boolean;
}

export interface CommandNotice {
  readonly commandId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly kind: "error" | "running" | "success";
  readonly markdown?: string;
  readonly output?: CommandOutput;
  readonly path: readonly string[];
  readonly sessionId?: string;
  readonly text?: string;
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

export interface CommandCatalogResponse {
  readonly catalog: UiWebCommandCatalog;
  readonly ok: true;
}

export interface CurrentModelResponse {
  readonly model: UiCurrentModelConfig | null;
  readonly ok: true;
}

export interface ModelConnectRequest {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelConnectResponse {
  readonly model: UiConnectModelResult;
  readonly ok: true;
}

export interface ModelContextWindowProbeResponse {
  readonly ok: true;
  readonly probe: UiProbeModelContextWindowResult;
}

export interface SearchApiKeyRequest {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly provider?: "tavily";
}

export interface SearchApiKeyResponse {
  readonly ok: true;
  readonly search: UiSetSearchApiKeyResult;
}

export interface ContextWindowUsageResponse {
  readonly ok: true;
  readonly usage: UiContextWindowUsage | null;
}

export interface CompactSessionRequest {
  readonly force?: boolean;
}

export interface CompactSessionResponse {
  readonly compact: UiCompactSessionResult;
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

export type ExecuteCommandRequest = UiSlashCommandInvocation;
export type CommandOutput = UiSlashCommandOutput;

export type PermissionResponseRequest =
  | UiPermissionResponse
  | { readonly response: UiPermissionResponse };
