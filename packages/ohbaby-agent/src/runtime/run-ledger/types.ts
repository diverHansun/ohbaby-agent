export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TriggerSource = "user";

export interface RunLedgerRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly triggerSource: TriggerSource;
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
}

export interface CreatePendingRunLedgerInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly triggerSource: TriggerSource;
}

export interface ListRunLedgerOptions {
  readonly limit?: number;
}

export interface MarkInterruptedOptions {
  readonly statuses?: readonly RunStatus[];
  readonly reason?: string;
}

export interface MarkInterruptedResult {
  readonly updatedCount: number;
}

export interface RunLedger {
  createPending(input: CreatePendingRunLedgerInput): Promise<RunLedgerRecord>;
  markRunning(runId: string): Promise<RunLedgerRecord>;
  markSucceeded(runId: string): Promise<RunLedgerRecord>;
  markFailed(runId: string, error: unknown): Promise<RunLedgerRecord>;
  markCancelled(runId: string, reason?: string): Promise<RunLedgerRecord>;
  markInterrupted(
    options?: MarkInterruptedOptions,
  ): Promise<MarkInterruptedResult>;
  get(runId: string): Promise<RunLedgerRecord | undefined>;
  listBySession(
    sessionId: string,
    options?: ListRunLedgerOptions,
  ): Promise<RunLedgerRecord[]>;
  getActiveRuns(sessionId?: string): Promise<RunLedgerRecord[]>;
}

export interface InMemoryRunLedgerOptions {
  readonly now?: () => number;
}
