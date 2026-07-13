export type LayerType =
  | "agent"
  | "base"
  | "custom"
  | "environment"
  | "mcp-tools"
  | "task";

export type AgentKind = "primary" | "subagent";
export type PrimaryTaskKind = "plan" | "agent";
export type SubagentTaskKind = "explore" | "research" | "generic";
export type PromptTaskKind = PrimaryTaskKind | SubagentTaskKind;

export interface SubagentRolePromptInfo {
  readonly role: string;
  readonly description: string;
  readonly default?: boolean;
}

export interface EnvironmentInfo {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly date: string;
  readonly isGitRepo: boolean;
  readonly osVersion?: string;
}

export interface AssembleOptions {
  readonly agentName: string;
  readonly agentPrompt?: string;
  readonly agentPromptAddon?: string;
  readonly isSubagent: boolean;
  readonly availableSubagentRoles?: readonly SubagentRolePromptInfo[];
  readonly environment: EnvironmentInfo;
  readonly customInstructions?: readonly string[];
  readonly taskKind?: PromptTaskKind;
  readonly mcpToolNames?: readonly string[];
  readonly tools?: readonly string[];
}
