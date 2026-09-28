import type { ReasoningConfig } from "../../config/llm/types.js";
import type { UiPromptError } from "ohbaby-sdk";

export type PromptSubmissionStatus =
  | "steered"
  | "queued"
  | "retained"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface PromptSubmissionRecord {
  readonly steerReceipt?: import("./current-run-inputs.js").SteerQueuedPromptReceipt;
  readonly reasoning?: ReasoningConfig;
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
  readonly acceptedAt?: number;
  readonly admissionOrder?: number;
  readonly endTimeSource?: "recovery";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface AcceptPromptSubmissionInput {
  readonly reasoning?: ReasoningConfig;
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

type PromptTerminalResult =
  | {
      readonly status: "succeeded";
      readonly error?: never;
    }
  | {
      readonly status: "failed";
      readonly error: UiPromptError;
    }
  | {
      readonly status: "cancelled";
      readonly error?: never;
    }
  | {
      readonly status: "interrupted";
      readonly error: UiPromptError;
    };

export type FinishPromptSubmissionInput = PromptTerminalResult & {
  readonly expectedRunId?: string;
  readonly endedAt?: number;
  readonly endTimeSource?: "recovery";
};

export interface PromptHistoryWindow {
  readonly messageIds?: readonly string[];
  readonly runIds?: readonly string[];
}

export interface PromptResubmissionReceipt {
  readonly operationId: string;
  readonly promptId: string;
  readonly userMessageId: string;
  readonly sessionId: string;
  readonly acceptedAt: number;
}

export interface ResubmitRetainedPromptInput {
  readonly scopeKey: string;
  readonly promptId: string;
  readonly operationId: string;
  readonly editLeaseId: string;
  readonly ownerClientId?: string;
  readonly text: string;
  readonly maxQueuedPrompts: number;
}

export interface ResubmitRetainedPromptResult {
  readonly record: PromptSubmissionRecord;
  readonly receipt: PromptResubmissionReceipt;
  readonly inserted: boolean;
}

export interface RecoverPromptSubmissionsOptions {
  readonly scopeKey?: string;
  readonly sessionId?: string;
  /** Only after the caller has closed this owner's execution admission. */
  readonly includeCurrentOwner?: boolean;
  /** Offline legacy recovery only; absence of an owner is not death evidence. */
  readonly recoverUnknownOwner?: boolean;
}

export interface PromptSubmissionStore {
  resubmitRetained(
    input: ResubmitRetainedPromptInput,
  ): Promise<ResubmitRetainedPromptResult>;
  getResubmissionReceipt(
    scopeKey: string,
    operationId: string,
  ): Promise<PromptResubmissionReceipt | undefined>;
  retainOwnedQueued(scopeKey?: string): Promise<number>;
  recoverAllInterrupted(
    options?: RecoverPromptSubmissionsOptions,
  ): Promise<number>;

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
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord>;
  releaseEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord>;
  cancelQueued(
    promptId: string,
    editLeaseId?: string,
    ownerClientId?: string,
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
  /** Durable receipt existence, including terminal history without message/run associations. */
  hasForSession(scopeKey: string, sessionId: string): Promise<boolean>;
  listForSession(
    scopeKey: string,
    sessionId: string,
    window?: PromptHistoryWindow,
  ): Promise<readonly PromptSubmissionRecord[]>;
  listScopesWithQueued(): Promise<readonly string[]>;
  recoverInterrupted(scopeKey: string): Promise<number>;
}

export interface PromptExecutionControls {
  readonly signal: AbortSignal;
  markRunning(runId: string): Promise<void>;
}

export type PromptExecutionResult = PromptTerminalResult & {
  readonly endedAt?: number;
};

export type PromptSubmissionExecutor = (
  prompt: PromptSubmissionRecord,
  controls: PromptExecutionControls,
) => Promise<PromptExecutionResult>;

export function sameReasoning(
  left?: ReasoningConfig,
  right?: ReasoningConfig,
): boolean {
  return left?.enabled === right?.enabled && left?.effort === right?.effort;
}
