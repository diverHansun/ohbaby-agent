export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TriggerSource = "user";

export interface RunLedgerRecord {
  readonly steerClosedAt?: number;
  readonly inputsClosedAt?: number;
  readonly inputsCloseReason?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly triggerSource: TriggerSource;
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly endTimeSource?: "recovery";
  readonly error?: string;
  readonly errorData?: UiPromptError;
  readonly ownerId?: string;
  readonly ownerPid?: number;
}

export interface CreatePendingRunLedgerInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly triggerSource: TriggerSource;
  readonly ownerId?: string;
  readonly ownerPid?: number;
}

export type ClaimPendingRunLedgerInput = CreatePendingRunLedgerInput;

export interface ListRunLedgerOptions {
  readonly limit?: number;
}

export interface MarkRunTerminalOptions {
  readonly endedAt?: number;
}

export interface RecoverOrphanedRunsOptions {
  readonly sessionId?: string;
  /** Only an explicitly validated offline migration may recover legacy owners. */
  readonly recoverUnknownOwner?: boolean;
}

export interface MarkInterruptedOptions extends RecoverOrphanedRunsOptions {
  readonly statuses?: readonly RunStatus[];
  readonly reason?: string;
}

export interface MarkInterruptedResult {
  readonly updatedCount: number;
}

export interface RunLedger {
  readonly runtimeInputMemory?: {
    sealSteer(runId: string, at: number): void;
    get(runId: string): RunLedgerRecord | undefined;
    close(runId: string, reason: string, at: number): void;
  };
  createPending(input: CreatePendingRunLedgerInput): Promise<RunLedgerRecord>;
  claimPendingRun(input: ClaimPendingRunLedgerInput): Promise<RunLedgerRecord>;
  markRunning(runId: string): Promise<RunLedgerRecord>;
  markSucceeded(
    runId: string,
    options?: MarkRunTerminalOptions,
  ): Promise<RunLedgerRecord>;
  markFailed(
    runId: string,
    error: unknown,
    errorData?: UiPromptError,
    options?: MarkRunTerminalOptions,
  ): Promise<RunLedgerRecord>;
  markCancelled(
    runId: string,
    reason?: string,
    options?: MarkRunTerminalOptions,
  ): Promise<RunLedgerRecord>;
  markRunInterrupted(
    runId: string,
    reason?: string,
    options?: MarkRunTerminalOptions,
  ): Promise<RunLedgerRecord>;
  markInterrupted(
    options?: MarkInterruptedOptions,
  ): Promise<MarkInterruptedResult>;
  recoverOrphanedRuns(
    options?: RecoverOrphanedRunsOptions,
  ): Promise<MarkInterruptedResult>;
  get(runId: string): Promise<RunLedgerRecord | undefined>;
  listBySession(
    sessionId: string,
    options?: ListRunLedgerOptions,
  ): Promise<RunLedgerRecord[]>;
  getActiveRuns(sessionId?: string): Promise<RunLedgerRecord[]>;
}

export interface InMemoryRunLedgerOptions {
  readonly isOwnerAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly ownerId?: string;
  readonly ownerPid?: number;
}
import type { UiPromptError } from "ohbaby-sdk";
