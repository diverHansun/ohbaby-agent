/** A complete primary-session snapshot. Failed reads never imply removal. */
export interface UiSubagentInstanceSnapshot {
  readonly rootSessionId: string;
  readonly runtimeEpoch: string;
  readonly bindingGeneration?: number;
  /** Monotonic per root and runtime. Within the same binding, replace only with a greater revision. */
  readonly revision: number;
  readonly complete: true;
  readonly instances: readonly UiSubagentInstance[];
}

export interface UiSubagentInstance {
  readonly rootSessionId: string;
  readonly subagentId: string;
  readonly displayName: string;
  readonly description: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** pending: preparing accepted work; cancelled: cancellation/close; interrupted: stopped or recovered execution. */
  readonly status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "cancelled";
  /** Present while an execution still owns its slot, including cleanup. */
  readonly currentExecutionId?: string;
  readonly latestExecutionId?: string;
  readonly mode?: "foreground" | "background";
  readonly approvalBlocked: boolean;
  /** Required execution cleanup, excluding naturally detached shell jobs. */
  readonly settling: boolean;
  readonly unprocessedMessageCount: number;
}

export interface UiSubagentInstanceQuery {
  readonly rootSessionId: string;
  readonly runtimeEpoch?: string;
  readonly bindingGeneration?: number;
  readonly signal?: AbortSignal;
}

export interface UiSubagentStopInput extends UiSubagentInstanceQuery {
  readonly subagentId: string;
  /** The backend checks this identity atomically with stop admission. */
  readonly expectedExecutionId: string;
}

export interface UiSubagentStopResult {
  readonly rootSessionId: string;
  readonly subagentId: string;
  readonly expectedExecutionId: string;
  /** accepted only acknowledges interruption. Status follows actual termination; settling remains true until cleanup is confirmed. */
  readonly outcome:
    | "accepted"
    | "confirmed"
    | "not_running"
    | "execution_changed";
  /** Current row after admission; clients also refresh the complete snapshot. */
  readonly instance: UiSubagentInstance;
}

/** Reuses UiEvent delivery; invalidation instructs clients to reload a snapshot. */
export interface UiSubagentInstancesInvalidatedEvent {
  readonly type: "subagent.instances.invalidated";
  readonly rootSessionId: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
}

/** Terminal UI read/control error. Release the watch; do not reconnect it. */
export interface UiSubagentClosedError {
  readonly code: "SUBAGENT_CLOSED";
  readonly message: string;
}

/** Unknown or cross-root instance. A changed transport selection uses SESSION_SCOPE_CHANGED. */
export interface UiSubagentNotFoundError {
  readonly code: "SUBAGENT_NOT_FOUND";
  readonly message: string;
}

/** Instance reads and controls. Closed instances reject with SUBAGENT_CLOSED; execution-history readers remain separate. */
export interface UiSubagentInstanceClient {
  listSubagentInstances(
    input: UiSubagentInstanceQuery,
  ): Promise<UiSubagentInstanceSnapshot>;
  stopSubagent(input: UiSubagentStopInput): Promise<UiSubagentStopResult>;
}
