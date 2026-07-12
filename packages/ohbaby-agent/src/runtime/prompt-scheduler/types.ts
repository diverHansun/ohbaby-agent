import type { UiPromptError } from "ohbaby-sdk";

export type PromptSubmissionStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface PromptSubmissionRecord {
  readonly promptId: string;
  readonly clientRequestId: string;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly text: string;
  readonly status: PromptSubmissionStatus;
  readonly runId?: string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly editLeaseId?: string;
  readonly editLeaseOwnerId?: string;
  readonly editLeaseExpiresAt?: number;
  readonly error?: UiPromptError;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface AcceptPromptSubmissionInput {
  readonly promptId: string;
  readonly clientRequestId: string;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly text: string;
  readonly maxQueuedPrompts: number;
}

export interface AcceptPromptSubmissionResult {
  readonly record: PromptSubmissionRecord;
  readonly inserted: boolean;
}

export interface PromptEditLease {
  readonly editLeaseId: string;
  readonly ownerClientId: string;
  readonly expiresAt: number;
  readonly prompt: PromptSubmissionRecord;
}

export interface FinishPromptSubmissionInput {
  readonly status: Extract<
    PromptSubmissionStatus,
    "succeeded" | "failed" | "cancelled" | "interrupted"
  >;
  readonly expectedRunId?: string;
  readonly error?: UiPromptError;
}

export interface PromptSubmissionStore {
  assertCapacity(scopeKey: string, maxQueuedPrompts: number): Promise<void>;
  accept(
    input: AcceptPromptSubmissionInput,
  ): Promise<AcceptPromptSubmissionResult>;
  get(promptId: string): Promise<PromptSubmissionRecord | undefined>;
  getByClientRequestId(
    scopeKey: string,
    clientRequestId: string,
  ): Promise<PromptSubmissionRecord | undefined>;
  acquireEditLease(
    promptId: string,
    ownerClientId: string,
    ttlMs: number,
  ): Promise<PromptEditLease>;
  renewEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId: string,
    ttlMs: number,
  ): Promise<PromptEditLease>;
  commitEdit(
    promptId: string,
    editLeaseId: string,
    text: string,
  ): Promise<PromptSubmissionRecord>;
  releaseEditLease(
    promptId: string,
    editLeaseId: string,
  ): Promise<PromptSubmissionRecord>;
  cancelQueued(
    promptId: string,
    editLeaseId?: string,
  ): Promise<PromptSubmissionRecord>;
  claim(promptId: string): Promise<PromptSubmissionRecord | null>;
  requeueBusy(promptId: string): Promise<PromptSubmissionRecord>;
  markRunning(promptId: string, runId: string): Promise<PromptSubmissionRecord>;
  finish(
    promptId: string,
    input: FinishPromptSubmissionInput,
  ): Promise<PromptSubmissionRecord>;
  listQueued(scopeKey: string): Promise<readonly PromptSubmissionRecord[]>;
  listVisible(scopeKey: string): Promise<readonly PromptSubmissionRecord[]>;
  listScopesWithQueued(): Promise<readonly string[]>;
  recoverInterrupted(scopeKey: string): Promise<number>;
}

export interface PromptExecutionControls {
  markRunning(runId: string): Promise<void>;
}

export interface PromptExecutionResult {
  readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly error?: UiPromptError;
}

export type PromptSubmissionExecutor = (
  prompt: PromptSubmissionRecord,
  controls: PromptExecutionControls,
) => Promise<PromptExecutionResult>;
