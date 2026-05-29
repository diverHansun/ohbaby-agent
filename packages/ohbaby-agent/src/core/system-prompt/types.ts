import type { PromptSecurityFinding } from "./security/index.js";

export type LayerType =
  | "agent"
  | "custom"
  | "environment"
  | "identity"
  | "task"
  | "tools";

export type AgentKind = "primary" | "subagent";
export type PrimaryTaskKind = "ask" | "plan" | "agent";
export type SubagentTaskKind = "explore" | "research" | "generic";
export type PromptTaskKind = PrimaryTaskKind | SubagentTaskKind;

export interface SubagentRolePromptInfo {
  readonly role: string;
  readonly description: string;
  readonly default?: boolean;
}

export interface ToolPromptInfo {
  readonly name: string;
  readonly snippet?: string;
  readonly guidelines?: readonly string[];
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
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
  readonly promptGuidelines?: readonly string[];
  readonly taskKind?: PromptTaskKind;
  readonly toolSnippets?: Readonly<Partial<Record<string, string>>>;
  readonly tools?: readonly string[];
}
