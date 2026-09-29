import type { UiReasoningConfig } from "./connect-model.js";
/** Original skill intent, separate from the expanded execution input. */
export interface UiPromptNamingSource {
  readonly skillName: string;
  readonly request: string;
}

export function isUiPromptNamingSource(
  value: unknown,
): value is UiPromptNamingSource {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "skillName" in value &&
    typeof value.skillName === "string" &&
    "request" in value &&
    typeof value.request === "string"
  );
}

export type UiPromptSubmissionStatus =
  | "steered"
  | "queued"
  | "retained"
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
  readonly steerReceipt?: UiSteerQueuedPromptReceipt;
  readonly reasoning?: UiReasoningConfig;
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
  readonly acceptedAt?: string;
  readonly admissionOrder?: number;
  readonly endTimeSource?: "recovery";
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export type UiPromptTerminalStatus = Extract<
  UiPromptSubmissionStatus,
  "succeeded" | "failed" | "cancelled" | "interrupted" | "steered"
>;

type UiCompletedPromptBase = Omit<
  UiPromptSubmission,
  "status" | "endedAt" | "error"
> & {
  readonly endedAt: string;
};

export type UiCompletedPromptSubmission =
  | (UiCompletedPromptBase & {
      readonly status: "steered";
      readonly error?: never;
    })
  | (UiCompletedPromptBase & {
      readonly status: "succeeded";
      readonly error?: never;
    })
  | (UiCompletedPromptBase & {
      readonly status: "failed";
      readonly error: UiPromptError;
    })
  | (UiCompletedPromptBase & {
      readonly status: "cancelled";
      readonly error?: never;
    })
  | (UiCompletedPromptBase & {
      readonly status: "interrupted";
      readonly error: UiPromptError;
    });

export interface UiPromptReceipt {
  readonly promptId: string;
  readonly clientRequestId: string;
  readonly userMessageId: string;
  readonly sessionId: string;
  readonly status: UiPromptSubmissionStatus;
  readonly createdAt: string;
}

export interface UiPromptCompletion {
  readonly prompt: UiCompletedPromptSubmission;
}

export interface UiEditQueuedPromptInput {
  readonly promptId: string;
  readonly text: string;
  readonly editLeaseId: string;
}

export interface UiResubmitRetainedPromptInput extends UiEditQueuedPromptInput {
  readonly operationId: string;
}

export interface UiPromptResubmissionReceipt {
  readonly operationId: string;
  readonly promptId: string;
  readonly userMessageId: string;
  readonly sessionId: string;
  readonly acceptedAt: number;
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
}

export interface UiRenewPromptEditLeaseInput {
  readonly promptId: string;
  readonly editLeaseId: string;
}

export interface UiReleasePromptEditLeaseInput {
  readonly promptId: string;
  readonly editLeaseId: string;
}

/** Transfers one queued submission into this exact active run, without changing its reasoning settings. */
export interface UiSteerQueuedPromptInput {
  readonly promptId: string;
  readonly expectedRunId: string;
  readonly clientRequestId: string;
}
export interface UiSteerQueuedPromptReceipt {
  readonly promptId: string;
  readonly userMessageId: string;
  readonly inputId: string;
  readonly acceptedTargetRunId: string;
  readonly acceptedAt: number;
  readonly clientRequestId: string;
}
