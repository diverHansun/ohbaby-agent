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
