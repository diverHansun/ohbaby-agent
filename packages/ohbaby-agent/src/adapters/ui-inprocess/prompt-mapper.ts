import type {
  UiCompletedPromptSubmission,
  UiPromptSubmission,
} from "ohbaby-sdk";
import type { PromptSubmissionRecord } from "../../runtime/prompt-scheduler/index.js";
import type { PromptExecutionResult } from "../../runtime/prompt-scheduler/index.js";
import type { RunCompletion } from "../../runtime/run-manager/index.js";

export function runCompletionToPromptExecutionResult(
  completion: RunCompletion | undefined,
): PromptExecutionResult {
  if (completion === undefined || completion.status === "succeeded") {
    return { status: "succeeded" };
  }
  if (completion.status === "cancelled") {
    return { status: "cancelled" };
  }
  const status = completion.status;
  return {
    error: completion.errorData ?? {
      code: status === "interrupted" ? "RUN_INTERRUPTED" : "RUN_FAILED",
      message: completion.error ?? `Run ${status}`,
      retryable: status === "interrupted",
      source: "runtime",
      ...(completion.terminalReason === undefined
        ? {}
        : { terminalReason: completion.terminalReason }),
    },
    status,
  };
}

export function promptRecordToUi(
  record: PromptSubmissionRecord,
): UiPromptSubmission {
  return {
    promptId: record.promptId,
    clientRequestId: record.clientRequestId,
    scopeKey: record.scopeKey,
    sessionId: record.sessionId,
    userMessageId: record.userMessageId,
    text: record.text,
    status: record.status,
    runId: record.runId,
    error: record.error,
    editLeaseOwnerId: record.editLeaseOwnerId,
    editLeaseExpiresAt:
      record.editLeaseExpiresAt === undefined
        ? undefined
        : new Date(record.editLeaseExpiresAt).toISOString(),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    startedAt:
      record.startedAt === undefined
        ? undefined
        : new Date(record.startedAt).toISOString(),
    endedAt:
      record.endedAt === undefined
        ? undefined
        : new Date(record.endedAt).toISOString(),
  };
}

export function promptRecordToCompletion(
  record: PromptSubmissionRecord,
): UiCompletedPromptSubmission {
  const { endedAt, error, status, ...prompt } = promptRecordToUi(record);
  if (
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  ) {
    throw new Error(`Prompt ${record.promptId} is not terminal: ${status}`);
  }
  if (endedAt === undefined) {
    throw new Error(`Terminal prompt ${record.promptId} has no endedAt`);
  }
  if (status === "failed" || status === "interrupted") {
    if (error === undefined) {
      throw new Error(
        `Terminal prompt ${record.promptId} has no structured error`,
      );
    }
    return { ...prompt, endedAt, error, status };
  }
  if (error !== undefined) {
    throw new Error(
      `Terminal prompt ${record.promptId} must not carry an error`,
    );
  }
  return { ...prompt, endedAt, status };
}
