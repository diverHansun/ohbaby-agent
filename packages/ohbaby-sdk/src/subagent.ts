import type { UiMessage } from "./snapshot.js";
import type { UiHistoryBoundary, UiSessionVersion } from "./session-view.js";

export interface UiSubagentBudget {
  readonly elapsedMs: number;
  readonly activeMs: number;
  readonly remainingMs: number;
  readonly approvalWaitMs: number;
}
export interface UiSubagentExecution {
  readonly executionId: string;
  readonly subagentId: string;
  readonly rootSessionId: string;
  readonly rootRunId: string;
  readonly childSessionId?: string;
  readonly childScopeId?: string;
  readonly childRunId?: string;
  readonly status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "timed_out";
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly updatedAt: number;
  readonly terminalReason?: string;
  readonly resultStored: boolean;
  readonly delivery:
    | "none"
    | "foreground"
    | "pending"
    | "delivered"
    | "processed";
  readonly processedRequestId?: string;
  readonly artifactPath?: string;
  readonly budget?: UiSubagentBudget;
}
export interface UiSubagentQuery {
  readonly runtimeEpoch?: string;
  readonly bindingGeneration?: number;
  readonly rootSessionId: string;
  readonly before?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
export interface UiSubagentExecutionList extends UiHistoryBoundary {
  readonly executions: readonly UiSubagentExecution[];
  readonly waiting: boolean;
  readonly approvalBlocked: boolean;
  readonly activeCount: number;
  readonly completedCount: number;
}
export interface UiSubagentExecutionView {
  readonly execution: UiSubagentExecution;
  readonly version?: UiSessionVersion;
  readonly messages: readonly UiMessage[];
  readonly history: UiHistoryBoundary;
  readonly reasoningMissing: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly readOnly: true;
}
export interface UiSubagentReadClient {
  listSubagentExecutions(
    input: UiSubagentQuery,
  ): Promise<UiSubagentExecutionList>;
  getSubagentExecutionView(
    input: UiSubagentQuery & { readonly executionId: string },
  ): Promise<UiSubagentExecutionView>;
}
