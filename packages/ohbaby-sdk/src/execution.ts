import type { UiMessage, UiRun, UiToolCall } from "./snapshot.js";

export interface UiModelRequest {
  readonly endTimeSource?: "recovery";
  readonly requestId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly step: number;
  readonly attempt: number;
  readonly purpose: string;
  readonly startedAt: number;
  readonly firstTextAt?: number;
  readonly endedAt?: number;
  readonly outcome: "running" | "success" | "error" | "aborted";
}
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
): UiModelRequest | undefined {
  if (run.status.kind !== "running") return undefined;
  return messages
    .filter(
      (message) => message.runId === run.id && message.role === "assistant",
    )
    .flatMap((message) =>
      (message.modelRequests ?? []).filter(
        (request) =>
          request.runId === run.id &&
          request.messageId === message.id &&
          request.purpose === "agent-step" &&
          request.endedAt === undefined &&
          request.outcome === "running",
      ),
    )
    .sort((a, b) => b.startedAt - a.startedAt)
    .at(0);
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
