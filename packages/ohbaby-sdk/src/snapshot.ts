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

export type UiPolicyMode = "agent" | "ask" | "plan";

export type UiPolicyAgentState = "ask-before-edit" | "edit-automatically";

export interface UiPolicyState {
  readonly mode: UiPolicyMode;
  readonly agentState: UiPolicyAgentState;
}

export interface UiSnapshot {
  readonly sessions: readonly UiSession[];
  readonly activeSessionId: string | null;
  readonly runs: readonly UiRun[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly status: UiRunStatus;
  readonly policy?: UiPolicyState;
}

export interface UiSession {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly UiMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UiRun {
  readonly id: string;
  readonly sessionId: string;
  readonly status: UiRunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface UiMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly parts: readonly UiMessagePart[];
  readonly createdAt: string;
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
