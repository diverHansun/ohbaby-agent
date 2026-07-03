import type { UiContextWindowUsage } from "./context-window.js";

export type UiRunStatus =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly runId: string;
      readonly title?: string;
    }
  | { readonly kind: "waiting-for-permission"; readonly requestId: string }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly recoverable: boolean;
    };

export type UiPermissionMode = "plan" | "auto";

export type UiPermissionLevel = "default" | "full-access";

export type UiPermissionRuleDecision = "allow" | "deny";

export type UiPermissionRuleScope = "session";

export interface UiPermissionRule {
  readonly tool: string;
  readonly pattern?: string;
  readonly decision: UiPermissionRuleDecision;
  readonly scope: UiPermissionRuleScope;
  readonly reason?: string;
}

export interface UiSessionPermissionRules {
  readonly sessionId: string;
  readonly rules: readonly UiPermissionRule[];
}

export interface UiPermissionState {
  readonly mode: UiPermissionMode;
  readonly level: UiPermissionLevel;
  readonly sessionRules: readonly UiSessionPermissionRules[];
}

export interface UiSnapshot {
  readonly sessions: readonly UiSession[];
  readonly activeSessionId: string | null;
  readonly runs: readonly UiRun[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly status: UiRunStatus;
  readonly permission?: UiPermissionState;
  readonly contextWindowUsages?: readonly UiContextWindowUsage[];
  readonly goals?: readonly UiSessionGoal[];
}

export type UiGoalStatus = "active" | "paused";

export interface UiGoal {
  readonly status: UiGoalStatus;
  readonly objective: string;
  readonly pauseReason?: string;
}

export interface UiSessionGoal {
  readonly sessionId: string;
  readonly goal: UiGoal;
}

export interface UiSession {
  readonly id: string;
  readonly title: string;
  readonly projectRoot?: string;
  readonly messages: readonly UiMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UiRun {
  readonly id: string;
  readonly sessionId: string;
  readonly status: UiRunStatus;
  readonly startedAt: string;
  readonly terminalReason?: string;
  readonly updatedAt: string;
}

export interface UiMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly parts: readonly UiMessagePart[];
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly completedAt?: string;
  readonly status?: "streaming" | "completed" | "error";
  readonly finishReason?: string;
}

export type UiMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: UiToolCall }
  | { readonly type: "tool-result"; readonly result: UiToolResult };

export interface UiToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly status: "pending" | "running" | "completed" | "failed";
}

export interface UiToolResult {
  readonly callId: string;
  readonly output: string;
  readonly error?: string;
}

export interface UiPermissionRequest {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly UiPermissionChoice[];
}

export interface UiPermissionChoice {
  readonly id: string;
  readonly label: string;
  readonly intent: "allow" | "deny" | "abort";
}

export interface UiPermissionResponse {
  readonly choiceId: string;
  readonly remember?: boolean;
}
