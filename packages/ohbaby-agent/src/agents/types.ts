import type { ToolExecutionEnvironment } from "../core/tool-scheduler/index.js";
import type { AgentRunResult } from "../core/agents/index.js";
import type { SubagentRole } from "./roles.js";

export type AgentMode = "primary" | "subagent" | "all";
export type PermissionValue = "allow" | "deny" | "ask";

export interface ToolsConfig {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface PermissionConfig {
  readonly edit?: PermissionValue;
  readonly bash?: PermissionValue | Readonly<Record<string, PermissionValue>>;
  readonly web?: PermissionValue;
  readonly mcp?: PermissionValue;
  readonly externalDirectory?: PermissionValue;
  readonly doomLoop?: PermissionValue;
}

export interface AgentConfig {
  readonly name: string;
  readonly description?: string;
  readonly mode: AgentMode;
  readonly hidden?: boolean;
  readonly default?: boolean;
  readonly color?: string;
  readonly disabled?: boolean;
  readonly maxSteps?: number;
  readonly timeout?: number;
  readonly allowDoomLoop?: boolean;
  readonly model?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly tools?: ToolsConfig;
  readonly permission?: PermissionConfig;
  /**
   * Additive runtime prompt refinement appended after the default base/task
   * prompt. This must not replace the default core/system-prompt identity or
   * task contract.
   */
  readonly prompt?: string;
}

export interface AgentsConfig {
  readonly agents: Readonly<Record<string, AgentConfig>>;
}

export interface RuntimeAgent {
  readonly config: AgentConfig;
  readonly isSubagent: boolean;
  readonly systemPrompt: string;
  readonly tools: Record<string, boolean>;
}

export interface AgentPromptProvider {
  build(input: {
    readonly agent: AgentConfig;
    readonly isSubagent: boolean;
  }): Promise<string> | string;
}

export interface SubagentExecuteParams {
  readonly role: SubagentRole;
  readonly name?: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly description?: string;
  readonly resumeSessionId?: string;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
}

export interface SubagentToolCallSummary {
  readonly id: string;
  readonly tool: string;
  readonly status: "completed" | "error";
  readonly title?: string;
}

export interface SubagentResult {
  readonly role: SubagentRole;
  readonly name?: string;
  readonly description?: string;
  readonly sessionId: string;
  readonly success: boolean;
  readonly output: string;
  readonly summary: {
    readonly toolCalls: readonly SubagentToolCallSummary[];
    readonly steps: number;
    readonly duration: number;
  };
}

export interface StartSessionParams {
  readonly agentName: string;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly runId?: string;
  readonly title?: string;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly maxSteps?: number;
}

export type AgentSessionStartResult = Extract<
  AgentRunResult,
  { readonly mode: "stream" }
>;

export interface TaskExecutor {
  execute(params: SubagentExecuteParams): Promise<SubagentResult>;
}
