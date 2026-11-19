import type { UiMessage, UiRun, UiToolCall } from "./snapshot.js";

export interface UiAgentStepRequest {
  readonly endTimeSource?: "recovery";
  readonly requestId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly step: number;
  readonly attempt: number;
  readonly purpose: "agent-step";
  readonly startedAt: number;
  readonly firstTextAt?: number;
  readonly endedAt?: number;
  /** The failed attempt ended with a decision to retry, not a replay instruction. */
  readonly retryScheduled?: true;
  readonly outcome: "running" | "success" | "error" | "aborted";
}
export type UiSummaryRequest = Omit<
  UiAgentStepRequest,
  "runId" | "step" | "purpose"
> & {
  readonly purpose: "context-summary";
  readonly compactionId: string;
};
export type UiModelRequest = UiAgentStepRequest | UiSummaryRequest;
export type UiModelActivity = UiModelRequest & {
  readonly phase?: "requesting" | "retrying";
  readonly waitingStartedAt?: number;
};
export interface UiToolExecution {
  readonly runId?: string;
  readonly phase:
    | "preparing"
    | "awaiting-approval"
    | "waiting-predecessor"
    | "queued"
    | "executing"
    | "ended";
  readonly phaseStartedAt: number;
  readonly createdAt: number;
  readonly executionStartedAt?: number;
  readonly endedAt?: number;
  readonly waitReason?:
    | "capacity"
    | "predecessor"
    | "resource"
    | "source-cleanup";
  readonly outcome?:
    | "success"
    | "error"
    | "rejected"
    | "cancelled"
    | "timed-out";
  readonly cleanup?: "in-progress" | "confirmed" | "unconfirmed";
}
/** The caller supplies messages belonging to this run's real session. */
export function projectModelActivity(
  run: UiRun,
  messages: readonly UiMessage[],
): UiModelActivity | undefined {
  if (run.status.kind !== "running" || run.outcome !== undefined)
    return undefined;
  const requests = messages
    .filter(
      (message) => message.runId === run.id && message.role === "assistant",
    )
    .flatMap((message) =>
      (message.modelRequests ?? []).filter(
        (request): request is UiAgentStepRequest =>
          request.purpose === "agent-step" &&
          request.runId === run.id &&
          request.messageId === message.id,
      ),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  const latest = requests.at(-1);
  if (!latest) return undefined;
  const active = latest.outcome === "running" && latest.endedAt === undefined;
  const backingOff =
    latest.outcome === "error" && latest.retryScheduled === true;
  if (!active && !backingOff) return undefined;

  // A reset to attempt 1 (including overflow recovery) starts a new wait. A
  // step retry moves the chain to a new message; it stays one wait.
  let first = requests.length - 1;
  while (first > 0 && requests[first].attempt !== 1) {
    const previous = requests[first - 1];
    if (
      previous.step !== latest.step ||
      (previous.messageId !== requests[first].messageId &&
        previous.retryScheduled !== true)
    )
      break;
    first--;
  }
  // Say "retrying" only while the user has seen nothing: a retry after output
  // reads as the model thinking again.
  const failure = requests
    .slice(first)
    .findLast((request) => request.retryScheduled === true);
  const progressOf = (messageId: string): boolean =>
    hasVisibleOutput(messages.find((message) => message.id === messageId));
  return {
    ...latest,
    phase:
      failure !== undefined &&
      !progressOf(failure.messageId) &&
      !progressOf(latest.messageId)
        ? "retrying"
        : "requesting",
    waitingStartedAt: requests[first].startedAt,
  };
}

function hasVisibleOutput(message: UiMessage | undefined): boolean {
  return (
    message?.hiddenToolCalls === true ||
    message?.parts.some((part) => {
      if (
        part.metadata?.kind === "lifecycle-interruption" ||
        part.metadata?.kind === "context-compaction"
      )
        return false;
      return part.type === "text" || part.type === "reasoning"
        ? part.text.trim().length > 0
        : part.type === "tool-call" &&
            part.call.id.length > 0 &&
            part.call.name.length > 0;
    }) === true
  );
}
/** Assistant attempts that were followed by a started request in the same step. */
export function listRetriedAttemptIds(
  messages: readonly UiMessage[],
): ReadonlySet<string> {
  const retried = new Set<string>();
  for (const message of messages) {
    const failed = getScheduledStepRetry(message);
    if (
      failed &&
      messages.some(
        (later) =>
          later.id !== message.id &&
          later.role === "assistant" &&
          later.runId === failed.runId &&
          later.modelRequests?.some(
            (request) =>
              request.purpose === "agent-step" &&
              request.messageId === later.id &&
              request.runId === failed.runId &&
              request.step === failed.step &&
              request.attempt > failed.attempt &&
              request.startedAt > 0,
          ),
      )
    )
      retried.add(message.id);
  }
  return retried;
}

/** The failed request scheduling a retry, even before the message error is projected. */
export function getScheduledStepRetry(
  message: UiMessage,
): UiAgentStepRequest | undefined {
  if (message.role !== "assistant" || message.status === "completed")
    return undefined;
  const last = message.modelRequests?.findLast(
    (request): request is UiAgentStepRequest =>
      request.purpose === "agent-step" &&
      request.messageId === message.id &&
      request.runId === message.runId,
  );
  return last?.outcome === "error" && last.retryScheduled === true
    ? last
    : undefined;
}
/** Copy only public facts; internal admission owners never cross this boundary. */
export function projectToolExecution(
  execution: UiToolExecution,
): UiToolExecution;
export function projectToolExecution(
  execution: UiToolExecution | undefined,
): UiToolExecution | undefined;
export function projectToolExecution(
  execution: UiToolExecution | undefined,
): UiToolExecution | undefined {
  if (
    !execution ||
    ![
      "preparing",
      "awaiting-approval",
      "waiting-predecessor",
      "queued",
      "executing",
      "ended",
    ].includes(execution.phase) ||
    !Number.isFinite(execution.phaseStartedAt) ||
    !Number.isFinite(execution.createdAt)
  )
    return undefined;
  const {
    runId,
    phase,
    phaseStartedAt,
    createdAt,
    executionStartedAt,
    endedAt,
    waitReason,
    outcome,
    cleanup,
  } = execution;
  return {
    runId,
    phase,
    phaseStartedAt,
    createdAt,
    executionStartedAt,
    endedAt,
    waitReason,
    outcome,
    cleanup,
  };
}
export function toolExecutionStatus(
  execution: UiToolExecution | undefined,
  fallback: UiToolCall["status"],
): UiToolCall["status"] {
  if (!execution) return fallback;
  if (execution.phase === "ended")
    return execution.outcome === "success" && fallback !== "failed"
      ? "completed"
      : "failed";
  return execution.phase === "executing" ? "running" : "pending";
}

export function mergeModelRequests(
  previous: readonly UiModelRequest[] = [],
  updates: readonly UiModelRequest[],
): readonly UiModelRequest[] {
  const records = new Map(
    previous.map((request) => [request.requestId, request]),
  );
  for (const request of updates) {
    const existing = records.get(request.requestId);
    if (existing?.endedAt !== undefined) continue;
    records.set(request.requestId, { ...existing, ...request });
  }
  return [...records.values()];
}
export function mergeToolExecution(
  previous: UiToolExecution | undefined,
  update: UiToolExecution,
): UiToolExecution {
  if (previous?.phase === "ended")
    return { ...previous, cleanup: update.cleanup ?? previous.cleanup };
  if (previous && previous.phaseStartedAt > update.phaseStartedAt)
    return previous;
  return projectToolExecution(update);
}
