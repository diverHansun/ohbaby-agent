import type {
  UiEvent,
  SessionSyncState,
  UiSessionControl,
  UiPermissionBinding,
  UiPermissionSnapshot,
  UiSessionIndexEntry,
  PermissionSyncState,
  UiReasoningConfig,
  UiCompactSessionResult,
  UiContextWindowUsage,
  UiConnectModelResult,
  UiConnectModelInterfaceProvider,
  UiCurrentModelConfig,
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionResponse,
  UiPermissionState,
  UiPromptCompletion,
  UiPromptReceipt,
  UiPromptEditLease,
  UiPromptSubmission,
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
  readonly directory?: string;
  readonly startupIntent?: WebStartupIntent;
  readonly token: string;
}

export interface WorkspaceScopeSummary {
  readonly available: boolean;
  readonly directory: string;
  readonly lastOpenedAt: number;
  readonly loaded: boolean;
  readonly position: number;
}

export interface WorkspaceSnapshot {
  readonly scopes: readonly WorkspaceScopeSummary[];
  readonly selectedDirectory: string | null;
}

export interface WorkspaceScopesResponse {
  readonly ok: true;
  readonly scopes: readonly WorkspaceScopeSummary[];
}

export interface WorkspaceOpenResponse {
  readonly ok: true;
  readonly scope: WorkspaceScopeSummary;
}

export interface DirectoryPickerRoot {
  readonly directory: string;
  readonly name: string;
}

export interface DirectoryPickerRootsResponse {
  readonly ok: true;
  readonly roots: readonly DirectoryPickerRoot[];
}

export interface DirectoryPickerEntry {
  readonly directory: string;
  readonly name: string;
}

export interface DirectoryPickerListResponse {
  readonly children: readonly DirectoryPickerEntry[];
  readonly directory: string;
  readonly ok: true;
  readonly parent: string | null;
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

export interface UnknownPromptRequest {
  readonly directory: string;
  readonly runtimeEpoch: string;
  readonly clientRequestId: string;
  readonly sessionId?: string;
  readonly status: "unknown" | "epoch-changed";
  /** Transient UI state; never persisted with the unresolved identity. */
  readonly submitting?: boolean;
}
export interface StoreSnapshot {
  readonly durationSample?: {
    readonly serverNow: number;
    readonly receivedAt: number;
  };
  readonly sessionSync: SessionSyncState;
  readonly sessionControl: UiSessionControl | null;
  readonly historyState: "loading" | "ready" | "error";
  readonly historyError?: string;
  readonly historyBefore?: string;
  readonly historyHasMore: boolean;
  readonly historyStale: boolean;
  readonly unknownPromptRequests: readonly UnknownPromptRequest[];
  readonly permissionSync: PermissionSyncState;
  readonly sessionIndex: readonly UiSessionIndexEntry[];
  readonly connectionState: ConnectionState;
  readonly currentModel: UiCurrentModelConfig | null;
  readonly error: string | null;
  readonly view: ViewState;
}

export interface RegisterClientResponse extends UiPermissionBinding {
  readonly clientId: string;
  readonly ok: true;
}

export interface PermissionSnapshotResponse {
  readonly ok: true;
  readonly snapshot: UiPermissionSnapshot;
}
export interface SessionIndexResponse {
  readonly ok: true;
  readonly sessions: readonly UiSessionIndexEntry[];
}
export interface BindingResponse extends UiPermissionBinding {
  readonly runtimeEpoch?: string;
  readonly sessionRecoveryVersion?: number;
  readonly subagentConversationVersion?: number;
  readonly ok: true;
}

export interface SnapshotResponse {
  readonly ok: true;
  readonly seqNum: number;
  readonly snapshot: UiSnapshot;
}

export interface PromptAcceptedResponse extends UiPromptReceipt {
  readonly ok: true;
}

export interface PromptCompletionResponse {
  readonly completion: UiPromptCompletion;
  readonly ok: true;
}

export interface PromptMutationResponse {
  readonly ok: true;
  readonly prompt: UiPromptSubmission;
}

export interface PromptLeaseResponse {
  readonly lease: UiPromptEditLease;
  readonly ok: true;
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
  readonly provider?: string;
  readonly baseUrl: string;
  readonly interfaceProvider?: UiConnectModelInterfaceProvider;
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
      readonly runtimeEpoch?: string;
      readonly sessionRecoveryVersion?: number;
      readonly subagentConversationVersion?: number;
      readonly permissionEpoch: string;
      readonly rootSessionId: string | null;
      readonly bindingGeneration: number;
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
  readonly namingSource?: import("ohbaby-sdk").UiPromptNamingSource;
  readonly reasoning?: UiReasoningConfig;
  readonly clientRequestId: string;
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
  | {
      readonly response: UiPermissionResponse;
      readonly context: UiPermissionBinding;
    };
