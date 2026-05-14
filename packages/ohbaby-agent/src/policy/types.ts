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
  readonly getMode: () => Mode;
  readonly setMode: (mode: Mode) => void;
  readonly cycleMode: () => Mode;
  readonly getAgentState: () => AgentState;
  readonly setAgentState: (state: AgentState) => void;
  readonly toggleAgentState: () => AgentState;
  readonly getState: () => PolicyState;
  readonly check: (input: PolicyCheckInput) => PolicyDecision;
}
