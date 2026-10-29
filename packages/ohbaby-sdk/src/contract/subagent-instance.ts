/** A complete primary-session snapshot. Failed reads never imply removal. */
export interface UiSubagentInstanceSnapshot {
  readonly rootSessionId: string;
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
}

/** Terminal UI read/control error. Release the watch; do not reconnect it. */
export interface UiSubagentClosedError {
  readonly code: "SUBAGENT_CLOSED";
  readonly message: string;
}

/** Additive contract for B1/B2; existing execution-history clients remain valid. */
export interface UiSubagentInstanceClient {
  listSubagentInstances(
    input: UiSubagentInstanceQuery,
  ): Promise<UiSubagentInstanceSnapshot>;
  stopSubagent(input: UiSubagentStopInput): Promise<UiSubagentStopResult>;
}
