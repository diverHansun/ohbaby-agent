export type UiShellJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";
export type UiShellJobStopReason =
  | "timeout"
  | "user"
  | "model"
  | "owner-ended"
  | "output-limit"
  | "rewound"
  | "session-closed"
  | "shutdown";
export type UiShellJobCleanup = "in-progress" | "confirmed" | "unconfirmed";
export type UiShellJobOwnerFilter =
  | { readonly kind: "main" | "subagents" }
  | { readonly kind: "subagent"; readonly subagentId: string };

export interface UiShellJobVersion {
  readonly rootSessionId: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly bindingGeneration?: number;
}
export interface UiShellJobQuery {
  readonly rootSessionId: string;
  readonly runtimeEpoch?: string;
  readonly bindingGeneration?: number;
  readonly signal?: AbortSignal;
}
export interface UiShellJobListQuery extends UiShellJobQuery {
  readonly owner?: UiShellJobOwnerFilter;
  readonly statuses?: readonly UiShellJobStatus[];
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface UiShellJobRow {
  readonly jobId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly ownerKind: "main" | "subagent";
  readonly managedByCurrentBackend: boolean;
  readonly canStop: boolean;
  readonly ownerName: string;
  readonly subagentId?: string;
  readonly childRunId?: string;
  readonly command: string;
  readonly description: string | null;
  readonly mode: "foreground" | "background";
  readonly status: UiShellJobStatus;
  readonly stopReason: UiShellJobStopReason | null;
  readonly cleanup: UiShellJobCleanup | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly resultReadyAt: number | null;
  readonly settledAt: number | null;
  readonly timeoutMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly trackingReleasedAt: number | null;
}
export interface UiShellJobList extends UiShellJobVersion {
  readonly rows: readonly UiShellJobRow[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly pendingStartCount: number;
  readonly filteredCount: number;
  /** Counts in the owner/search scope, before the selected status filter. */
  readonly statusCounts: Readonly<Record<UiShellJobStatus, number>>;
  /** Unreleased cleanup=unconfirmed rows in the owner/search scope. */
  readonly unconfirmedCount: number;
}
export interface UiShellJobTarget extends UiShellJobQuery {
  readonly jobId: string;
}
export interface UiShellJobOutput extends UiShellJobVersion {
  readonly source: "live" | "saved";
  readonly sampledAt: number;
  readonly job: UiShellJobRow;
  readonly output: string;
  readonly tailAvailable: boolean;
  readonly outputBytes: number;
  readonly outputComplete: boolean | null;
  /** Last durable checkpoint; live bytes/tail may be newer, as indicated by sampledAt. */
  readonly outputCheckpointAt: number | null;
  readonly outputTruncated: boolean;
  readonly logAvailable: boolean;
  readonly logPath?: string;
  readonly logError?: string;
}
export interface UiShellJobLogQuery extends UiShellJobTarget {
  readonly offset?: number;
  readonly maxBytes?: number;
}
export interface UiShellJobLog extends UiShellJobVersion {
  readonly jobId: string;
  readonly available: boolean;
  /** Text is decoded from this byte range; an arbitrary byte seek can split a UTF-8 character. */
  readonly encoding: "utf-8";
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly bytesRead: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly outputComplete: boolean | null;
  readonly error?: string;
}
export interface UiShellJobStopResult extends UiShellJobVersion {
  /** Admission feedback; job.cleanup records whether process cleanup is confirmed. */
  readonly outcome: "accepted" | "already-terminal";
  readonly job: UiShellJobRow;
}
export interface UiShellJobAbandonInput extends UiShellJobTarget {
  readonly confirm: true;
}
export interface UiShellJobAbandonResult extends UiShellJobVersion {
  readonly trackingReleasedAt: number;
  readonly job: UiShellJobRow;
}
export interface UiShellJobReadClient {
  listShellJobs(input: UiShellJobListQuery): Promise<UiShellJobList>;
  getShellJobOutput(input: UiShellJobTarget): Promise<UiShellJobOutput>;
  readShellJobLog(input: UiShellJobLogQuery): Promise<UiShellJobLog>;
}
export interface UiShellJobCommandClient {
  stopShellJob(input: UiShellJobTarget): Promise<UiShellJobStopResult>;
  abandonShellJob(
    input: UiShellJobAbandonInput,
  ): Promise<UiShellJobAbandonResult>;
}
export interface UiShellJobsInvalidatedEvent {
  readonly type: "shell-jobs.invalidated";
  readonly rootSessionId: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
}
