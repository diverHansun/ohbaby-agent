export type PermissionType =
  | "tool"
  | "bash"
  | "skill"
  | "external_directory";

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

export interface PermissionInfo {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId?: string;
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
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId?: string;
  readonly toolName: string;
  readonly category: PermissionToolCategory;
  readonly params: Record<string, unknown>;
  readonly reason?: string;
}

export interface PermissionManager {
  ask(input: PermissionAskInput): Promise<SchedulerPermissionResponse>;
  respond(
    sessionId: string,
    permissionId: string,
    response: PermissionResponse,
  ): void;
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
