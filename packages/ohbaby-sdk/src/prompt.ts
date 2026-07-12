export type UiPromptSubmissionStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface UiPromptError {
  readonly code: string;
  readonly message: string;
  readonly source: "provider" | "runtime" | "scheduler" | "validation";
  readonly retryable: boolean;
  readonly providerId?: string;
  readonly statusCode?: number;
  readonly attempts?: number;
  readonly limit?: number;
  readonly terminalReason?: string;
}

export interface UiPromptSubmission {
  readonly promptId: string;
  readonly clientRequestId: string;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly text: string;
  readonly status: UiPromptSubmissionStatus;
  readonly runId?: string;
  readonly error?: UiPromptError;
  readonly editLeaseOwnerId?: string;
  readonly editLeaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface UiPromptReceipt {
  readonly promptId: string;
  readonly clientRequestId: string;
  readonly userMessageId: string;
  readonly sessionId: string;
  readonly status: UiPromptSubmissionStatus;
  readonly createdAt: string;
}

export interface UiPromptCompletion {
  readonly prompt: UiPromptSubmission;
}

export interface UiEditQueuedPromptInput {
  readonly promptId: string;
  readonly text: string;
  readonly editLeaseId: string;
}

export interface UiCancelQueuedPromptInput {
  readonly promptId: string;
  readonly editLeaseId?: string;
}

export interface UiPromptEditLease {
  readonly editLeaseId: string;
  readonly ownerClientId: string;
  readonly expiresAt: string;
  readonly prompt: UiPromptSubmission;
}

export interface UiAcquirePromptEditLeaseInput {
  readonly promptId: string;
  readonly ownerClientId: string;
}

export interface UiRenewPromptEditLeaseInput {
  readonly promptId: string;
  readonly editLeaseId: string;
  readonly ownerClientId: string;
}

export interface UiReleasePromptEditLeaseInput {
  readonly promptId: string;
  readonly editLeaseId: string;
}
