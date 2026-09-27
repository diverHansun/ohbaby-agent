import { describe, expect, it } from "vitest";
import { classifyApprovalBlocking } from "./approval-blocking.js";
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
