import { createBus } from "../../bus/index.js";
import { MessageEvent } from "../../core/message/events.js";
import { PermissionEvent } from "../../permission/events.js";
import type { ToolPart } from "../../core/message/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  classifyApprovalBlocking,
  subscribeApprovalExecutionChanges,
} from "./approval-blocking.js";
import type { PermissionInfo } from "../../permission/types.js";
import type { ToolExecutionObservation } from "../../core/tool-scheduler/types.js";
const pending: PermissionInfo = {
  id: "permission",
  sessionId: "child",
  contextScopeId: "scope",
  rootSessionId: "parent",
  ancestorSessionIds: ["parent"],
  runId: "run",
  callId: "first",
  messageId: "message",
  type: "tool",
  name: "write",
  title: "Approve write",
  metadata: {},
  pattern: "write",
  time: { created: 1 },
};
const approval: ToolExecutionObservation = {
  phase: "awaiting-approval",
  runId: "run",
  phaseStartedAt: 1,
  createdAt: 1,
};
const waiting: ToolExecutionObservation = {
  ...approval,
  phase: "waiting-predecessor",
  waitReason: "predecessor",
  predecessorsKnown: true,
  blockingCallIds: ["first"],
};
const owner = { sessionId: "child", contextScopeId: "scope", runId: "run" };
describe("pure approval blocking", () => {
  it("allows an ended required predecessor alongside an approval predecessor", () => {
    expect(
      classifyApprovalBlocking({
        ...owner,
        requestsActive: false,
        permissions: [pending],
        tools: [
          {
            callId: "ended",
            messageId: "message",
            execution: { ...approval, phase: "ended" },
          },
          { callId: "first", messageId: "message", execution: approval },
          {
            callId: "second",
            messageId: "message",
            execution: { ...waiting, blockingCallIds: ["ended", "first"] },
          },
        ],
      }).blocked,
    ).toBe(true);
  });
  it("follows only known necessary predecessors in the same batch", () => {
    const result = classifyApprovalBlocking({
      ...owner,
      requestsActive: false,
      permissions: [pending],
      tools: [
        { callId: "first", messageId: "message", execution: approval },
        { callId: "second", messageId: "message", execution: waiting },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(result.permissionIds).toEqual(["permission"]);
  });
  it.each([
    "executing",
    "capacity",
    "resource",
    "unknown",
    "other-batch",
    "cycle",
    "model",
  ])("does not infer pure approval from %s", (kind) => {
    const execution: ToolExecutionObservation =
      kind === "executing"
        ? { ...approval, phase: "executing" }
        : kind === "capacity" || kind === "resource"
          ? { ...waiting, waitReason: kind }
          : kind === "unknown"
            ? { ...waiting, predecessorsKnown: false }
            : kind === "cycle"
              ? { ...waiting, blockingCallIds: ["second"] }
              : waiting;
    expect(
      classifyApprovalBlocking({
        ...owner,
        requestsActive: kind === "model",
        permissions: [pending],
        tools: [
          { callId: "first", messageId: "message", execution: approval },
          {
            callId: "second",
            messageId: kind === "other-batch" ? "other" : "message",
            execution,
          },
        ],
      }).blocked,
    ).toBe(false);
  });
  it("requires authoritative matching approval and ignores unrelated changes/timestamps", () => {
    const input = {
      ...owner,
      requestsActive: false,
      tools: [{ callId: "first", messageId: "message", execution: approval }],
    };
    const first = classifyApprovalBlocking({
      ...input,
      permissions: [pending],
    });
    expect(
      classifyApprovalBlocking({
        ...input,
        permissions: [
          { ...pending, id: "unrelated", runId: "different" },
          { ...pending, time: { created: 200 } },
        ],
      }).fingerprint,
    ).toBe(first.fingerprint);
    expect(
      classifyApprovalBlocking({ ...input, permissions: [] }).blocked,
    ).toBe(false);
    expect(
      classifyApprovalBlocking({
        ...input,
        permissions: [{ ...pending, contextScopeId: "different" }],
      }).blocked,
    ).toBe(false);
    expect(
      classifyApprovalBlocking({ ...input, tools: [], permissions: [pending] })
        .blocked,
    ).toBe(false);
  });
});

describe("approval execution wake subscription", () => {
  it("ignores content deltas and foreign runs but wakes immediately on structural changes", () => {
    const bus = createBus();
    const wake = vi.fn();
    const unsubscribe = subscribeApprovalExecutionChanges(
      bus,
      "child",
      "run",
      wake,
    );
    const part: ToolPart = {
      id: "part",
      sessionId: "child",
      messageId: "message",
      orderIndex: 0,
      type: "tool",
      callId: "first",
      tool: "write",
      state: { status: "running", input: {} },
      metadata: { execution: approval },
    };
    bus.publish(MessageEvent.PartUpdated, {
      part: { ...part, type: "text", text: "delta" },
      delta: "delta",
    });
    bus.publish(MessageEvent.PartUpdated, {
      part: { ...part, type: "reasoning", text: "delta" },
      delta: "delta",
    });
    bus.publish(MessageEvent.PartUpdated, {
      part: {
        ...part,
        metadata: { execution: { ...approval, runId: "other" } },
      },
    });
    expect(wake).not.toHaveBeenCalled();
    bus.publish(MessageEvent.PartUpdated, { part });
    expect(wake).toHaveBeenCalledTimes(1);
    bus.publish(MessageEvent.PartUpdated, {
      part: {
        ...part,
        state: { status: "running", input: {}, title: "streamed output" },
      },
      delta: "output",
    });
    bus.publish(MessageEvent.PartUpdated, {
      part: {
        ...part,
        metadata: { execution: { ...approval, phaseStartedAt: 999 } },
      },
    });
    expect(wake).toHaveBeenCalledTimes(1);
    bus.publish(MessageEvent.PartUpdated, {
      part: { ...part, metadata: { execution: waiting } },
    });
    bus.publish(MessageEvent.PartUpdated, {
      part: {
        ...part,
        metadata: { execution: { ...waiting, blockingCallIds: ["changed"] } },
      },
    });
    bus.publish(MessageEvent.PartUpdated, {
      part: {
        ...part,
        state: { status: "completed", input: {}, output: "done" },
        metadata: { execution: { ...waiting, blockingCallIds: ["changed"] } },
      },
    });
    expect(wake).toHaveBeenCalledTimes(4);
    bus.publish(MessageEvent.PartUpdated, {
      part: { ...part, id: "new-part" },
      delta: "output",
    });
    expect(wake).toHaveBeenCalledTimes(4);
    bus.publish(MessageEvent.PartUpdated, {
      part: {
        ...part,
        id: "new-part",
        metadata: { execution: { ...approval, phase: "executing" } },
      },
      delta: "output",
    });
    expect(wake).toHaveBeenCalledTimes(5);
    unsubscribe();
    bus.publish(MessageEvent.PartUpdated, { part });
    expect(wake).toHaveBeenCalledTimes(5);
  });
  it("wakes for matching permission Updated and Replied only, and unsubscribes both", () => {
    const bus = createBus();
    const wake = vi.fn();
    const unsubscribe = subscribeApprovalExecutionChanges(
      bus,
      "child",
      "run",
      wake,
    );
    bus.publish(PermissionEvent.Updated, {
      info: { ...pending, runId: "other" },
    });
    bus.publish(PermissionEvent.Updated, {
      info: { ...pending, sessionId: "other" },
    });
    expect(wake).not.toHaveBeenCalled();
    bus.publish(PermissionEvent.Updated, { info: pending });
    expect(wake).toHaveBeenCalledTimes(1);
    const reply = {
      sessionId: "child",
      runId: "run",
      rootSessionId: "parent",
      permissionId: "permission",
      callId: "first",
      reason: "reply",
      response: { type: "once" as const },
    };
    bus.publish(PermissionEvent.Replied, { ...reply, runId: "other" });
    bus.publish(PermissionEvent.Replied, { ...reply, sessionId: "other" });
    expect(wake).toHaveBeenCalledTimes(1);
    bus.publish(PermissionEvent.Replied, reply);
    expect(wake).toHaveBeenCalledTimes(2);
    unsubscribe();
    bus.publish(PermissionEvent.Updated, { info: pending });
    bus.publish(PermissionEvent.Replied, reply);
    expect(wake).toHaveBeenCalledTimes(2);
  });
});
