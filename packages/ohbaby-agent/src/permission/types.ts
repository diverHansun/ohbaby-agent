export type PermissionType =
  | "tool"
  | "bash"
  | "skill"
  | "external_directory"
  | "sensitive_path";

export type Mode = "plan" | "auto";

export type Level = "default" | "full-access";

export type PermissionDecision =
  | { readonly type: "allow"; readonly reason?: string }
  | {
      readonly type: "ask";
      readonly reason?: string;
      readonly rememberable?: boolean;
    }
  | { readonly type: "deny"; readonly reason: string };

export type PermissionRuleDecision = "allow" | "deny";

export type PermissionRuleScope = "session";

export interface PermissionRule {
  readonly tool: string;
  readonly pattern?: string;
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly reason?: string;
}

export type PermissionResponse =
  | { readonly type: "once" }
  | { readonly type: "always"; readonly pattern?: string }
  | { readonly type: "reject" }
  | { readonly type: "suggest"; readonly suggestion: string }
  | { readonly type: "cancel" };

export interface SystemPermissionResponse {
  readonly type: "auto_approved";
  readonly pattern: string;
}

export type PermissionEventResponse =
  | PermissionResponse
  | SystemPermissionResponse;

export type SchedulerPermissionResponse =
  | "once"
  | "always"
  | "reject"
  | "cancel";

export type PermissionToolCategory =
  | "readonly"
  | "write"
  | "dangerous"
  | "network"
  | "memory"
  | "skill"
  | "subagent";

export interface PermissionState {
  readonly mode: Mode;
  readonly level: Level;
  readonly sessionRules: Map<string, readonly PermissionRule[]>;
}

export interface UiPermissionState {
  readonly mode: Mode;
  readonly level: Level;
  readonly sessionRules: readonly {
    readonly sessionId: string;
    readonly rules: readonly PermissionRule[];
  }[];
}

export interface PermissionStateStore {
  getState(): PermissionState;
  getMode(): Mode;
  setMode(mode: Mode): void;
  toggleMode(): Mode;
  getLevel(): Level;
  setLevel(level: Level): void;
  getSessionRules(sessionId: string): readonly PermissionRule[];
  addSessionRule(
    sessionId: string,
    rule: PermissionRule,
    options?: { readonly silent?: boolean },
  ): void;
  clearSession(sessionId: string): void;
  toSnapshot(): UiPermissionState;
}

export interface PermissionCall {
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly category?: PermissionToolCategory;
  readonly params: Record<string, unknown>;
}

export interface PermissionSource {
  readonly rootSessionId: string;
  readonly ancestorSessionIds: readonly string[];
  readonly sourceLabel?: string;
}

export interface PermissionIdentity extends PermissionSource {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly messageId: string;
  readonly contextScopeId?: string;
}

export interface PermissionTerminal extends PermissionIdentity {
  readonly status: "resolved" | "revoked";
  readonly reason: string;
}

export type PermissionCommit =
  | { readonly type: "requested"; readonly info: PermissionInfo }
  | {
      readonly type: "resolved";
      readonly identity: PermissionTerminal;
      readonly response: PermissionEventResponse;
    };

export type PermissionRespondResult =
  | "accepted"
  | "already-resolved"
  | "revoked"
  | "not-pending";

export interface PermissionInfo extends PermissionIdentity {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly type: PermissionType;
  readonly name: string;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
  readonly pattern: string;
  readonly time: {
    readonly created: number;
  };
}

export interface PermissionAskInput {
  readonly runId: string;
  readonly source: PermissionSource;
  readonly signal: AbortSignal;
  readonly contextScopeId?: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly category: PermissionToolCategory;
  readonly params: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly reason?: string;
  readonly rememberable?: boolean;
}

export interface PermissionManager {
  readonly state: PermissionStateStore;
  ask(input: PermissionAskInput): Promise<SchedulerPermissionResponse>;
  respond(
    sessionId: string,
    permissionId: string,
    response: PermissionResponse,
  ): PermissionRespondResult;
  listPending(): readonly PermissionInfo[];
  getPending(permissionId: string): PermissionInfo | undefined;
  getTerminal(permissionId: string): PermissionTerminal | undefined;
  revoke(permissionId: string, reason: string): PermissionRespondResult;
  revokeByRun(runId: string, reason: string): void;
  revokeBySession(sessionId: string, reason: string): void;
  isHealthy(rootSessionId: string): boolean;
  freezeRoot(rootSessionId: string, error: Error): void;
  freezeRuntime(error: Error): void;
  dispose(): void;
  cancelPending(sessionId: string): void;
  clearSession(sessionId: string): void;
}

export interface PermissionPatternInput {
  readonly type: PermissionType;
  readonly name: string;
  readonly params: Record<string, unknown>;
}

export class PermissionRejectedError extends Error {
  constructor(permissionId: string) {
    super(`Permission rejected: ${permissionId}`);
    this.name = "PermissionRejectedError";
  }
}

export class PermissionRejectedWithSuggestionError extends Error {
  constructor(
    readonly permissionId: string,
    readonly suggestion: string,
  ) {
    super(`Permission rejected with suggestion: ${suggestion}`);
    this.name = "PermissionRejectedWithSuggestionError";
  }
}

export class PermissionUnavailableError extends Error {
  readonly code = "PERMISSION_UNAVAILABLE";
  constructor(
    readonly rootSessionId?: string,
    options?: ErrorOptions,
  ) {
    super(
      "PERMISSION_UNAVAILABLE: Permission processing is unavailable.",
      options,
    );
    this.name = "PermissionUnavailableError";
  }
}

export class InvalidPermissionChoiceError extends Error {
  readonly code = "INVALID_PERMISSION_CHOICE";
  constructor() {
    super(
      "INVALID_PERMISSION_CHOICE: This response is not available for this request.",
    );
    this.name = "InvalidPermissionChoiceError";
  }
}
