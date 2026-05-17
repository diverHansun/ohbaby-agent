import type { ToolExecutionEnvironment } from "../tool-scheduler/index.js";

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

export interface SystemPromptProvider {
  build(input: {
    readonly agent: AgentConfig;
    readonly isSubagent: boolean;
  }): Promise<string> | string;
}

export interface SubagentExecuteParams {
  readonly agentName: string;
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
  readonly sessionId: string;
  readonly success: boolean;
  readonly output: string;
  readonly summary: {
    readonly toolCalls: readonly SubagentToolCallSummary[];
    readonly steps: number;
    readonly duration: number;
  };
}

export interface TaskExecutor {
  execute(params: SubagentExecuteParams): Promise<SubagentResult>;
}

export interface SubagentSession {
  readonly id: string;
  readonly projectRoot: string;
  readonly agentName: string;
  readonly parentId?: string;
  readonly childrenIds: readonly string[];
  readonly isSubagent: boolean;
}

export interface SubagentSessionManager {
  create(
    projectDirectory: string,
    options?: {
      readonly id?: string;
      readonly title?: string;
      readonly agentName?: string;
      readonly parentId?: string;
    },
  ): Promise<SubagentSession>;
  get(sessionId: string): Promise<SubagentSession | null>;
}

export interface SubagentMessageWriter {
  writeUserMessage(input: {
    readonly sessionId: string;
    readonly parentSessionId: string;
    readonly agentName: string;
    readonly prompt: string;
  }): Promise<{ readonly messageId?: string } | void>;
}

export interface SubagentRunnerResult {
  readonly success: boolean;
  readonly output: string;
  readonly steps?: number;
  readonly toolCalls?: readonly SubagentToolCallSummary[];
}

export interface SubagentRunner {
  run(input: {
    readonly sessionId: string;
    readonly parentSessionId: string;
    readonly agentName: string;
    readonly prompt: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly signal?: AbortSignal;
    readonly environment?: ToolExecutionEnvironment;
  }): Promise<SubagentRunnerResult>;
}
