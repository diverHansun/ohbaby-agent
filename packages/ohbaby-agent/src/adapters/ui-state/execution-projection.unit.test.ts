import { describe, it, expect } from "vitest";
import { messageToUiMessage } from "./persistent-store.js";
import type { MessageWithParts } from "../../core/message/types.js";
import {
  listRetriedAttemptIds,
  projectModelActivity,
  type UiMessage,
  type UiRun,
} from "ohbaby-sdk";
const request = {
  requestId: "r",
  runId: "run",
  messageId: "m",
  step: 1,
  attempt: 1,
  purpose: "agent-step" as const,
  startedAt: 100,
  outcome: "running" as const,
};
describe("durable execution projection", () => {
  it("keeps one retry chain, uses current-message progress, and never revives an older wait", () => {
    const run: UiRun = {
      id: "run",
      sessionId: "s",
      status: { kind: "running", runId: "run" },
      startedAt: "2026",
      updatedAt: "2026",
    };
    const failed = {
      ...request,
      endedAt: 200,
      outcome: "error" as const,
      retryScheduled: true as const,
    };
    let message: UiMessage = {
      id: "m",
      runId: "run",
      role: "assistant",
      parts: [],
      createdAt: "2026",
      modelRequests: [failed],
    };
    expect(projectModelActivity(run, [message])).toMatchObject({
      phase: "retrying",
      waitingStartedAt: 100,
      endedAt: 200,
      outcome: "error",
    });
    const next = { ...request, requestId: "next", attempt: 2, startedAt: 300 };
    message = { ...message, modelRequests: [failed, next] };
    const old: UiMessage = {
      ...message,
      id: "old",
      modelRequests: [],
      parts: [{ type: "text", text: "previous step" }],
    };
    expect(projectModelActivity(run, [old, message])).toMatchObject({
      requestId: "next",
      phase: "retrying",
      waitingStartedAt: 100,
    });
    message = {
      ...message,
      parts: [
        { type: "reasoning", text: "  " },
        {
          type: "text",
          text: "interrupted",
          metadata: { kind: "lifecycle-interruption" },
        },
      ],
    };
    expect(projectModelActivity(run, [message])?.phase).toBe("retrying");
    message = { ...message, parts: [{ type: "reasoning", text: "progress" }] };
    expect(projectModelActivity(run, [message])?.phase).toBe("requesting");
    for (const outcome of ["success", "aborted", "error"] as const) {
      expect(
        projectModelActivity(run, [
          {
            ...message,
            modelRequests: [failed, { ...next, endedAt: 400, outcome }],
          },
        ]),
      ).toBeUndefined();
    }
    expect(
      projectModelActivity({ ...run, status: { kind: "idle" } }, [message]),
    ).toBeUndefined();
    const reset = { ...request, requestId: "reset", startedAt: 500 };
    expect(
      projectModelActivity(run, [
        { ...message, parts: [], modelRequests: [failed, next, reset] },
      ]),
    ).toMatchObject({ phase: "requesting", waitingStartedAt: 500 });
    expect(
      projectModelActivity(run, [{ ...message, runId: "child" }]),
    ).toBeUndefined();
  });
  it("keeps one Thinking wait across a step retry's new message and lists the replaced attempt", () => {
    const run: UiRun = {
      id: "run",
      sessionId: "s",
      status: { kind: "running", runId: "run" },
      startedAt: "2026",
      updatedAt: "2026",
    };
    const failed = {
      ...request,
      endedAt: 200,
      outcome: "error" as const,
      retryScheduled: true as const,
    };
    const replaced: UiMessage = {
      id: "m",
      runId: "run",
      role: "assistant",
      status: "error",
      parts: [{ type: "text", text: "half" }],
      createdAt: "2026",
      modelRequests: [failed],
    };
    const retry = {
      ...request,
      requestId: "next",
      messageId: "m2",
      attempt: 2,
      startedAt: 300,
    };
    const next: UiMessage = {
      ...replaced,
      id: "m2",
      status: "streaming",
      parts: [],
      modelRequests: [retry],
    };
    expect(listRetriedAttemptIds([replaced])).toEqual(new Set());
    expect(
      listRetriedAttemptIds([
        replaced,
        { ...next, modelRequests: [{ ...retry, startedAt: 0 }] },
      ]),
    ).toEqual(new Set());
    expect(
      listRetriedAttemptIds([
        replaced,
        { ...next, modelRequests: [{ ...retry, step: 2 }] },
      ]),
    ).toEqual(new Set());
    expect(listRetriedAttemptIds([replaced, next])).toEqual(new Set(["m"]));
    // The reader saw output, so the backoff and the new request read as Thinking.
    expect(projectModelActivity(run, [replaced])).toMatchObject({
      phase: "requesting",
      outcome: "error",
    });
    expect(projectModelActivity(run, [replaced, next])).toMatchObject({
      requestId: "next",
      phase: "requesting",
      waitingStartedAt: 100,
    });
    // The new request then fails before any output: now it says retrying.
    expect(
      projectModelActivity(run, [
        replaced,
        {
          ...next,
          modelRequests: [
            { ...retry, endedAt: 350, outcome: "error", retryScheduled: true },
            { ...retry, requestId: "third", attempt: 3, startedAt: 400 },
          ],
        },
      ]),
    ).toMatchObject({ phase: "retrying", attempt: 3, waitingStartedAt: 100 });
    // Another step's message never joins the chain.
    expect(
      projectModelActivity(run, [
        replaced,
        { ...next, modelRequests: [{ ...retry, step: 2 }] },
      ]),
    ).toMatchObject({ phase: "requesting", waitingStartedAt: 300 });
    // A failure without a scheduled retry is no replaced attempt and ends the wait.
    const unscheduled = {
      ...replaced,
      modelRequests: [{ ...failed, retryScheduled: undefined }],
    };
    expect(listRetriedAttemptIds([unscheduled, next])).toEqual(new Set());
    expect(projectModelActivity(run, [unscheduled, next])).toMatchObject({
      waitingStartedAt: 300,
    });
    // Retries in a row stay one wait and keep counting.
    const third: UiMessage = {
      ...next,
      id: "m3",
      modelRequests: [
        {
          ...retry,
          requestId: "third",
          messageId: "m3",
          attempt: 3,
          startedAt: 500,
        },
      ],
    };
    const nextFailed: UiMessage = {
      ...next,
      status: "error",
      parts: [{ type: "text", text: "half again" }],
      modelRequests: [
        { ...retry, endedAt: 400, outcome: "error", retryScheduled: true },
      ],
    };
    expect(listRetriedAttemptIds([replaced, nextFailed, third])).toEqual(
      new Set(["m", "m2"]),
    );
    expect(
      projectModelActivity(run, [replaced, nextFailed, third]),
    ).toMatchObject({
      requestId: "third",
      attempt: 3,
      phase: "requesting",
      waitingStartedAt: 100,
    });
  });
  it("retains model activity on zero-part assistant messages", () => {
    const record: MessageWithParts = {
      info: {
        id: "m",
        sessionId: "s",
        role: "assistant",
        agent: "default",
        runId: "run",
        time: { created: 100 },
        modelRequests: [request],
      },
      parts: [],
    };
    expect(messageToUiMessage(record)).toMatchObject({
      id: "m",
      modelRequests: [request],
    });
  });
  it("projects exact tool admission and cleanup without inventing execution start", () => {
    const execution = {
      runId: "run",
      phase: "queued" as const,
      createdAt: 100,
      phaseStartedAt: 200,
      waitReason: "resource" as const,
    };
    const record: MessageWithParts = {
      info: {
        id: "m",
        sessionId: "s",
        role: "assistant",
        agent: "default",
        runId: "run",
        time: { created: 100 },
      },
      parts: [
        {
          id: "p",
          messageId: "m",
          sessionId: "s",
          orderIndex: 0,
          type: "tool",
          callId: "call",
          tool: "bash",
          state: { status: "pending", input: {}, raw: "{}" },
          metadata: { execution },
        },
      ],
    };
    expect(messageToUiMessage(record)?.parts[0]).toMatchObject({
      call: { status: "pending", execution },
    });
  });
});
