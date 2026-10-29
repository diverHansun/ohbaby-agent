import type { UiSubagentInstance } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
  groupInstances,
  instanceStatusLabel,
  isFailedInstance,
  stoppableExecutionId,
} from "./instance-status.js";

function instance(
  subagentId: string,
  patch: Partial<UiSubagentInstance> = {},
): UiSubagentInstance {
  return {
    rootSessionId: "root",
    subagentId,
    displayName: subagentId,
    description: `${subagentId} task`,
    createdAt: 1,
    updatedAt: 1,
    status: "completed",
    approvalBlocked: false,
    settling: false,
    unprocessedMessageCount: 0,
    ...patch,
  };
}

describe("Subagents grouping", () => {
  it("puts starting, running, waiting and cleaning-up instances in Active and the rest in Done", () => {
    const groups = groupInstances([
      instance("pending", { status: "pending" }),
      instance("running", { status: "running", updatedAt: 5 }),
      instance("approval", { status: "completed", approvalBlocked: true }),
      instance("settling", { status: "interrupted", settling: true }),
      instance("interrupted", { status: "interrupted" }),
      instance("failed", { status: "failed" }),
      instance("timed_out", { status: "timed_out" }),
      instance("cancelled", { status: "cancelled" }),
      instance("completed", { status: "completed", updatedAt: 9 }),
    ]);
    expect(groups.active.map((item) => item.subagentId)).toEqual([
      "running",
      "pending",
      "approval",
      "settling",
    ]);
    expect(groups.done.map((item) => item.subagentId)).toEqual([
      "completed",
      "interrupted",
      "failed",
      "timed_out",
      "cancelled",
    ]);
  });

  it("keeps the real status in Done instead of calling it success", () => {
    expect(instanceStatusLabel(instance("a", { status: "interrupted" }))).toBe(
      "Interrupted",
    );
    expect(instanceStatusLabel(instance("a", { status: "failed" }))).toBe(
      "Failed",
    );
    expect(isFailedInstance(instance("a", { status: "timed_out" }))).toBe(true);
    expect(isFailedInstance(instance("a", { status: "interrupted" }))).toBe(
      false,
    );
  });

  it("labels approval and cleanup over the run status", () => {
    expect(
      instanceStatusLabel(
        instance("a", { status: "running", approvalBlocked: true }),
      ),
    ).toBe("Needs approval");
    expect(
      instanceStatusLabel(
        instance("a", { status: "interrupted", settling: true }),
      ),
    ).toBe("Cleaning up");
    expect(
      instanceStatusLabel(instance("a", { status: "running", settling: true })),
    ).toBe("Running");
  });

  it("offers Stop only for the execution that still runs", () => {
    expect(
      stoppableExecutionId(
        instance("a", { status: "running", currentExecutionId: "exec-2" }),
      ),
    ).toBe("exec-2");
    expect(
      stoppableExecutionId(
        instance("a", { status: "interrupted", currentExecutionId: "exec-2" }),
      ),
    ).toBeUndefined();
    expect(
      stoppableExecutionId(instance("a", { status: "running" })),
    ).toBeUndefined();
  });
});
