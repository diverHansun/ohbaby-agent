/** Instance settings HTTP reads use the workspace directory header, with no request body. */
export interface UiSettingsMcpTool {
  readonly name: string;
  readonly description: string;
  readonly mcpToolName: string;
}

export interface UiSettingsMcpServer {
  readonly name: string;
  readonly origin: "global" | "project" | "plugin";
  readonly enabled: boolean;
  readonly status: "connected" | "failed" | "disconnected" | "disabled";
  readonly error?: string;
  readonly toolCount: number;
  readonly tools: readonly UiSettingsMcpTool[];
}

export interface UiSettingsSkill {
  readonly name: string;
  readonly description: string;
  readonly source:
    | "project-native"
    | "user-native"
    | "claude-compatible"
    | "agents-compatible"
    | "codex-home"
    | "plugin";
  readonly scope: "user" | "project";
  readonly location: string;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
}

export interface UiSettingsAgent {
  readonly name: string;
  readonly description: string;
  readonly mode: "primary" | "subagent" | "all";
  readonly hidden: boolean;
  readonly origin: "builtin" | "global" | "project";
}

export interface UiSettingsMcpStatusResponse {
  readonly ok: true;
  readonly servers: readonly UiSettingsMcpServer[];
}

export interface UiSettingsSkillsResponse {
  readonly ok: true;
  readonly skills: readonly UiSettingsSkill[];
}

export interface UiSettingsAgentsResponse {
  readonly ok: true;
  readonly agents: readonly UiSettingsAgent[];
}

export interface UiSettingsSearchDefaults {
  readonly searchDepth: "basic" | "advanced";
  readonly maxResults: number;
  readonly topic: "general" | "news" | "finance";
  readonly timeout: number;
}
export interface UiSettingsSearch {
  readonly provider: "tavily";
  readonly apiKeyEnv: string | null;
  readonly apiKeyConfigured: boolean;
  readonly baseUrl?: string;
  readonly defaults: UiSettingsSearchDefaults;
}
export interface UiSettingsSearchUpdate {
  readonly provider?: "tavily";
  readonly apiKeyEnv?: string | null;
  /** Omitted keeps the saved credential; empty clears target usage. */
  readonly apiKey?: string;
  readonly baseUrl?: string | null;
  readonly defaults?: Partial<UiSettingsSearchDefaults>;
}
export interface UiSettingsSearchResponse extends UiSettingsSearch {
  readonly ok: true;
}
export interface UiSettingsSecretPatch {
  readonly set?: Readonly<Record<string, string>>;
  readonly unset?: readonly string[];
}
export type UiSettingsMcpTransport =
  | "stdio"
  | "http"
  | "http_streamable"
  | "sse";
export interface UiSettingsGlobalMcpServer {
  readonly name: string;
  readonly transport: UiSettingsMcpTransport;
  readonly enabled: boolean;
  readonly trust: boolean;
  readonly timeout: number;
  readonly includeTools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys: readonly string[];
  readonly headerKeys: readonly string[];
}
export interface UiSettingsMcpServerUpdate {
  readonly transport?: UiSettingsMcpTransport;
  readonly enabled?: boolean;
  readonly trust?: boolean;
  readonly timeout?: number;
  readonly includeTools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly env?: UiSettingsSecretPatch;
  readonly headers?: UiSettingsSecretPatch;
}
export interface UiSettingsGlobalMcpServersResponse {
  readonly ok: true;
  readonly servers: readonly UiSettingsGlobalMcpServer[];
}
export interface UiSettingsMcpServerUpdateResponse extends UiSettingsGlobalMcpServer {
  readonly ok: true;
  readonly overriddenIn: readonly string[];
}
export interface UiSettingsMcpServerDeleteResponse {
  readonly ok: true;
}
/** Reconnect takes no body and requires the workspace header. */
export type UiSettingsMcpReconnectResponse = UiSettingsMcpStatusResponse;
export interface UiSettingsInstanceBusyResponse {
  readonly ok: false;
  readonly error: { readonly code: "INSTANCE_BUSY"; readonly message: string };
}
export interface UiSettingsAboutResponse {
  readonly ok: true;
  readonly version: string;
  readonly ohbabyHome: string;
  /** Directory containing the active diagnostic file, when logging is enabled. */
  readonly logDirectory?: string;
  readonly diagnosticsFile?: string;
  readonly defaultWorkspace: string;
}

export interface UiSettingsModelCreate {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly interfaceProvider:
    | "openai-compatible"
    | "openai-responses"
    | "anthropic";
  readonly promptCache?: "auto" | "enabled" | "disabled";
  readonly label?: string;
  readonly apiKeyEnv?: string | null;
  readonly apiKey?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}
export type UiSettingsModelPatch = Partial<
  Omit<UiSettingsModelCreate, "label">
> & { readonly label?: string | null };
export interface UiSettingsModelSelect {
  readonly id: string;
}
export interface UiSettingsModel {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly label?: string;
  readonly baseUrl?: string;
  readonly interfaceProvider?: UiSettingsModelCreate["interfaceProvider"];
  readonly promptCache?: UiSettingsModelCreate["promptCache"];
  readonly apiKeyEnv?: string;
  readonly apiKeyConfigured: boolean;
  readonly configurationComplete: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
  readonly reasoning: import("./connect-model.js").UiReasoningCapabilityView;
}
export interface UiSettingsModels {
  readonly active: {
    readonly id: string;
    readonly provider: string;
    readonly model: string;
  } | null;
  readonly params: {
    readonly maxTokens: number;
    readonly temperature?: number;
    readonly contextWindowTokens?: number;
    readonly reasoning?: {
      readonly enabled?: boolean;
      readonly effort?: string;
    };
  };
  readonly models: readonly UiSettingsModel[];
}
export interface UiSettingsModelsResponse extends UiSettingsModels {
  readonly ok: true;
}
/** Mutations return the same complete ordered settings projection. */
export type UiSettingsModelCreateResponse = UiSettingsModelsResponse;
export type UiSettingsModelPatchResponse = UiSettingsModelsResponse;
export type UiSettingsModelSelectResponse = UiSettingsModelsResponse;
export type UiSettingsModelDeleteResponse = UiSettingsModelsResponse;
export type UiSettingsModelProviderDeleteResponse = UiSettingsModelsResponse;

/** Discover the saved target without selecting it; unknown is a successful result. */
export interface UiSettingsModelProbe {
  readonly id: string;
}
export interface UiSettingsModelProbeResponse {
  readonly ok: true;
  readonly reasoning: import("./connect-model.js").UiReasoningCapabilityView;
}
