import type { UiMessage } from "./snapshot.js";
import type {
  UiHistoryBoundary,
  UiSessionChangedEvent,
  UiSessionUnavailableEvent,
  UiSessionVersion,
  UiSessionView,
} from "./session-view.js";

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
  readonly childUserMessageId?: string;
  readonly delegationSequence?: number;
  readonly requestId?: string;
  readonly requesterRunId?: string;
  readonly requesterScopeId?: string;
  readonly parentSessionId?: string;
  readonly prompt?: string;
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
/** The logical subagent is resolved to its session and scope by the backend. */
export interface UiSubagentConversationQuery extends UiSubagentQuery {
  readonly subagentId: string;
  /** Client-generated admission ID when watching; ignored by conversation reads. */
  readonly watchId?: string;
  /** Monotonic client watch call order within one registered client. */
  readonly watchSequence?: number;
  readonly after?: string;
  readonly anchorExecutionId?: string;
}
export interface UiSubagentConversationView {
  /** Stable instance name; absent only on older servers. */
  readonly displayName?: string;
  readonly rootSessionId: string;
  readonly subagentId: string;
  /** Current live tail baseline; its version belongs to this logical scope. */
  readonly view: UiSessionView;
  /** Bounded history or anchor window, at the same projection version. */
  readonly messages: readonly UiMessage[];
  readonly history: UiHistoryBoundary & {
    readonly after?: string;
    readonly hasLater: boolean;
  };
  readonly executions: readonly UiSubagentExecution[];
  readonly anchorMessageId?: string;
  readonly anchorFound: boolean;
  /** Explicit fallback for legacy records without a recoverable transcript. */
  readonly storedResult?: string;
  readonly readOnly: true;
}
export interface UiSubagentConversationChangedEvent {
  readonly type: "subagent.conversation.changed";
  readonly rootSessionId: string;
  readonly subagentId: string;
  /** Transport selection token; source events omit it. */
  readonly watchId?: string;
  readonly change: UiSessionChangedEvent;
  readonly executions?: readonly UiSubagentExecution[];
}
export interface UiSubagentConversationUnavailableEvent {
  readonly type: "subagent.conversation.unavailable";
  readonly rootSessionId: string;
  readonly subagentId: string;
  readonly watchId?: string;
  readonly unavailable: UiSessionUnavailableEvent;
}
export type UiSubagentConversationEvent =
  | UiSubagentConversationChangedEvent
  | UiSubagentConversationUnavailableEvent;
export interface UiSubagentConversationSelection {
  readonly rootSessionId: string;
  readonly subagentId: string;
  readonly runtimeEpoch: string;
  readonly bindingGeneration: number;
  readonly watchId: string;
}
export interface UiSubagentConversationUnwatchQuery extends UiSubagentConversationQuery {
  readonly watchId: string;
}
export interface UiSubagentReadClient {
  listSubagentExecutions(
    input: UiSubagentQuery,
  ): Promise<UiSubagentExecutionList>;
  getSubagentExecutionView(
    input: UiSubagentQuery & { readonly executionId: string },
  ): Promise<UiSubagentExecutionView>;
  getSubagentConversationView(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationView>;
  watchSubagentConversation(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationSelection>;
  unwatchSubagentConversation(
    input: UiSubagentConversationUnwatchQuery,
  ): Promise<void>;
}
