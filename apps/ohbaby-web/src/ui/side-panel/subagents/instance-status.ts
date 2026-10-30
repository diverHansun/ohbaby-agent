import type { UiSubagentInstance } from "ohbaby-sdk";
import type { StatusTone } from "../../shared/StatusGlyph.js";

export interface SubagentInstanceGroups {
  readonly active: readonly UiSubagentInstance[];
  readonly done: readonly UiSubagentInstance[];
}

/**
 * Active/Done is a front-end grouping only (D39): starting, running, waiting
 * for approval and still cleaning up are Active; everything else is Done.
 * Done does not mean success, so rows keep their real status label.
 */
export function isActiveInstance(instance: UiSubagentInstance): boolean {
  return (
    instance.status === "pending" ||
    instance.status === "running" ||
    instance.settling ||
    instance.approvalBlocked
  );
}

/** Groups instances, newest change first within each group. */
export function groupInstances(
  instances: readonly UiSubagentInstance[],
): SubagentInstanceGroups {
  const sorted = [...instances].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  return {
    active: sorted.filter(isActiveInstance),
    done: sorted.filter((instance) => !isActiveInstance(instance)),
  };
}

const STATUS_LABELS: Record<UiSubagentInstance["status"], string> = {
  pending: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

/** The row's status: waiting for approval and cleanup override the run status. */
export function instanceStatusLabel(instance: UiSubagentInstance): string {
  if (instance.approvalBlocked) return "Needs approval";
  if (instance.settling && instance.status !== "running") return "Cleaning up";
  return STATUS_LABELS[instance.status];
}

/** The glyph beside the label; the overrides match instanceStatusLabel. */
export function instanceStatusTone(instance: UiSubagentInstance): StatusTone {
  if (instance.approvalBlocked) return "approval";
  if (instance.settling || instance.status === "pending") return "working";
  switch (instance.status) {
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
    case "timed_out":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
  }
}

/** Failures read in the danger colour; every other status stays neutral. */
export function isFailedInstance(instance: UiSubagentInstance): boolean {
  return instance.status === "failed" || instance.status === "timed_out";
}

/** The execution a Stop request may target; absent once nothing runs. */
export function stoppableExecutionId(
  instance: UiSubagentInstance,
): string | undefined {
  return instance.status === "running" || instance.status === "pending"
    ? instance.currentExecutionId
    : undefined;
}
