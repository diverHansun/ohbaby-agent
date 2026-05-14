export type Mode = "ask" | "plan" | "agent";

export type AgentState = "ask-before-edit" | "edit-automatically";

export type ToolCategory =
  | "readonly"
  | "write"
  | "dangerous"
  | "network"
  | "memory"
  | "skill"
  | "subagent";

export type PolicyDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly reason?: string }
  | { readonly type: "ask"; readonly reason?: string };

export interface PolicyState {
  readonly mode: Mode;
  readonly agentState: AgentState;
}

export interface PolicyCheckInput {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
  readonly messageId: string;
}

export interface PolicyManager {
  getMode(): Mode;
  setMode(mode: Mode): void;
  cycleMode(): Mode;
  getAgentState(): AgentState;
  setAgentState(state: AgentState): void;
  toggleAgentState(): AgentState;
  getState(): PolicyState;
  check(input: PolicyCheckInput): PolicyDecision;
}
