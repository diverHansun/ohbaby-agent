import type { RunModel } from "../core/run-model.js";
import type { SlashSkillUsage } from "../skill/usage.js";
import type { ReasoningConfig } from "ohbaby-llm";
import type { ToolExecutionEnvironment } from "../core/tool-scheduler/index.js";
import type { AgentRunResult } from "../core/agents/index.js";

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
  readonly tools?: ToolsConfig;
  readonly permission?: PermissionConfig;
  /**
   * Additive runtime prompt refinement appended after the default base/task
   * prompt. This must not replace the default core/system-prompt identity or
   * task contract.
   */
  readonly prompt?: string;
}

/** Reject removed static LLM settings, including explicitly undefined properties. */
export function assertNoStaticModelConfig(
  config: AgentConfig,
  source: string,
): void {
  for (const field of ["model", "maxTokens", "temperature", "topP"] as const) {
    if (Object.hasOwn(config, field)) {
      throw new Error(
        `Agent ${config.name} configuration from ${source} contains removed field ${field}; configure models in the LLM layer`,
      );
    }
  }
}

export type AgentOrigin = "builtin" | "global" | "project";

export interface AgentsConfig {
  readonly origins?: Readonly<Record<string, AgentOrigin>>;
  readonly agents: Readonly<Record<string, AgentConfig>>;
}

export interface RuntimeAgent {
  readonly config: AgentConfig;
  readonly isSubagent: boolean;
  readonly tools: Record<string, boolean>;
}

export interface StartSessionParams {
  readonly runModel: RunModel;
  readonly reasoning?: ReasoningConfig;
  readonly agentName: string;
  readonly initialUserMessageId?: string;
  /** Original user text when model input includes execution-only context. */
  readonly displayUserText?: string;
  readonly skillUsage?: SlashSkillUsage;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly runId?: string;
  readonly title?: string;
  readonly signal?: AbortSignal;
  /** Cancellation applies only until the worker accepts execution. */
  readonly preparationSignal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly maxSteps?: number;
}

export type AgentSessionStartResult = Extract<
  AgentRunResult,
  { readonly mode: "stream" }
>;
