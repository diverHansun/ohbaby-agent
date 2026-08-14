import { describe, expect, it } from "vitest";
import type { PromptSubmissionRecord } from "../../runtime/prompt-scheduler/index.js";
import {
  promptRecordToCompletion,
  promptRecordToUi,
  runCompletionToPromptExecutionResult,
} from "./prompt-mapper.js";

function promptRecord(
  overrides: Partial<PromptSubmissionRecord> = {},
): PromptSubmissionRecord {
  return {
    clientRequestId: "request_1",
    createdAt: 1,
    endedAt: 3,
    promptId: "prompt_1",
    scopeKey: "/workspace",
    sessionId: "session_1",
    status: "succeeded",
    text: "hello",
    updatedAt: 3,
    userMessageId: "message_1",
    ...overrides,
  };
}

describe("prompt record mapper", () => {
  it("keeps the broad submission shape for queue and snapshot views", () => {
    expect(
      promptRecordToUi(
        promptRecord({ endedAt: undefined, status: "queued", updatedAt: 2 }),
      ),
    ).toMatchObject({
      endedAt: undefined,
      status: "queued",
      updatedAt: "1970-01-01T00:00:00.002Z",
    });
  });

  it.each(["succeeded", "cancelled"] as const)(
    "maps a valid %s record without error",
    (status) => {
      expect(promptRecordToCompletion(promptRecord({ status }))).toMatchObject({
        endedAt: "1970-01-01T00:00:00.003Z",
        status,
      });
    },
  );

  it.each(["failed", "interrupted"] as const)(
    "maps a valid %s record with structured error",
    (status) => {
      const error = {
        code: "RUNTIME_ERROR",
        message: "stopped",
        retryable: false,
        source: "runtime",
      } as const;

      expect(
        promptRecordToCompletion(promptRecord({ error, status })),
      ).toMatchObject({ error, status });
    },
  );

  it("rejects a non-terminal record", () => {
    expect(() =>
      promptRecordToCompletion(
        promptRecord({ endedAt: undefined, status: "running" }),
      ),
    ).toThrow("is not terminal");
  });

  it("rejects a terminal record without endedAt", () => {
    expect(() =>
      promptRecordToCompletion(promptRecord({ endedAt: undefined })),
    ).toThrow("has no endedAt");
  });

  it("rejects failed and interrupted records without structured errors", () => {
    expect(() =>
      promptRecordToCompletion(
        promptRecord({ error: undefined, status: "failed" }),
      ),
    ).toThrow("has no structured error");
  });

  it("rejects succeeded and cancelled records that carry an error", () => {
    expect(() =>
      promptRecordToCompletion(
        promptRecord({
          error: {
            code: "STALE_ERROR",
            message: "should not survive",
            retryable: false,
            source: "runtime",
          },
          status: "succeeded",
        }),
      ),
    ).toThrow("must not carry an error");
  });

  it("preserves interrupted run completion as a structured prompt result", () => {
    expect(
      runCompletionToPromptExecutionResult({
        error: "daemon owner disappeared",
        errorData: {
          code: "RUN_OWNER_LOST",
          message: "run owner disappeared",
          retryable: true,
          source: "scheduler",
        },
        status: "interrupted",
      }),
    ).toEqual({
      error: {
        code: "RUN_OWNER_LOST",
        message: "run owner disappeared",
        retryable: true,
        source: "scheduler",
      },
      status: "interrupted",
    });
  });

  it("creates required structured errors for failed and interrupted fallbacks", () => {
    expect(
      runCompletionToPromptExecutionResult({
        error: "provider failed",
        status: "failed",
      }),
    ).toMatchObject({
      error: { code: "RUN_FAILED", message: "provider failed" },
      status: "failed",
    });
    expect(
      runCompletionToPromptExecutionResult({ status: "interrupted" }),
    ).toMatchObject({
      error: { code: "RUN_INTERRUPTED", message: "Run interrupted" },
      status: "interrupted",
    });
  });

  it("keeps succeeded and cancelled prompt results free of errors", () => {
    expect(
      runCompletionToPromptExecutionResult({ status: "succeeded" }),
    ).toEqual({ status: "succeeded" });
    expect(
      runCompletionToPromptExecutionResult({ status: "cancelled" }),
    ).toEqual({ status: "cancelled" });
  });
});
