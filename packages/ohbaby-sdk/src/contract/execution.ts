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

  // A reset to attempt 1 (including overflow recovery) starts a new wait.
  let first = requests.length - 1;
  while (first > 0 && requests[first].attempt !== 1) {
    const previous = requests[first - 1];
    if (
      previous.messageId !== latest.messageId ||
      previous.step !== latest.step
    )
      break;
    first--;
  }
  const chain = requests.slice(first);
  const message = messages.find(
    (candidate) => candidate.id === latest.messageId,
  );
  const hasProgress =
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
    });
  return {
    ...latest,
    phase:
      backingOff ||
      (chain.some((request) => request.retryScheduled) && !hasProgress)
        ? "retrying"
        : "requesting",
    waitingStartedAt: requests[first].startedAt,
  };
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
