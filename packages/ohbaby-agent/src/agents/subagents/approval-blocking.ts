import type { BusInstance, BusUnsubscribe } from "../../bus/index.js";
import { MessageEvent } from "../../core/message/events.js";
import { PermissionEvent } from "../../permission/events.js";
import type { PermissionInfo } from "../../permission/types.js";
import type { ToolExecutionObservation } from "../../core/tool-scheduler/types.js";

export interface ObservedChildTool {
  readonly callId: string;
  readonly messageId: string;
  readonly execution: ToolExecutionObservation;
}
export interface ApprovalBlocking {
  readonly blocked: boolean;
  readonly permissionIds: readonly string[];
  readonly fingerprint?: string;
}
/** Inspect known batch edges only. Unknown plans and independent work never pause time. */
export function classifyApprovalBlocking(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly requestsActive: boolean;
  readonly permissions: readonly PermissionInfo[];
  readonly tools: readonly ObservedChildTool[];
}): ApprovalBlocking {
  const no: ApprovalBlocking = { blocked: false, permissionIds: [] };
  if (input.requestsActive) return no;
  const active = input.tools.filter(
    (tool) =>
      tool.execution.runId === input.runId && tool.execution.phase !== "ended",
  );
  if (active.length === 0) return no;
  const key = (tool: Pick<ObservedChildTool, "messageId" | "callId">): string =>
    JSON.stringify([tool.messageId, tool.callId]);
  const byKey = new Map(
    input.tools
      .filter((tool) => tool.execution.runId === input.runId)
      .map((tool) => [key(tool), tool]),
  );
  const relevant = input.permissions.filter(
    (permission) =>
      permission.runId === input.runId &&
      permission.sessionId === input.sessionId &&
      permission.contextScopeId === input.contextScopeId,
  );
  const ids = new Set<string>();
  const visiting = new Set<string>();
  const resolved = new Map<string, boolean>();
  function blocked(tool: ObservedChildTool): boolean {
    if (tool.execution.phase === "ended") return true;
    const id = key(tool);
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return false;
    visiting.add(id);
    let result = false;
    if (tool.execution.phase === "awaiting-approval") {
      const permission = relevant.find(
        (p) => p.callId === tool.callId && p.messageId === tool.messageId,
      );
      if (permission) {
        ids.add(permission.id);
        result = true;
      }
    } else if (
      tool.execution.phase === "waiting-predecessor" &&
      tool.execution.waitReason === "predecessor" &&
      tool.execution.predecessorsKnown === true &&
      tool.execution.blockingCallIds?.length
    ) {
      result = tool.execution.blockingCallIds.every((callId) => {
        const predecessor = byKey.get(
          key({ callId, messageId: tool.messageId }),
        );
        return predecessor !== undefined && blocked(predecessor);
      });
    }
    visiting.delete(id);
    resolved.set(id, result);
    return result;
  }
  if (!active.every(blocked) || ids.size === 0) return no;
  const permissions = relevant
    .filter((p) => ids.has(p.id))
    .map((p) => [
      p.id,
      p.runId,
      p.sessionId,
      p.contextScopeId ?? null,
      p.messageId,
      p.callId,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    blocked: true,
    permissionIds: [...ids].sort(),
    fingerprint: JSON.stringify(permissions),
  };
}

export function subscribeApprovalExecutionChanges(
  bus: BusInstance,
  sessionId: string,
  runId: string,
  wake: () => void,
): BusUnsubscribe {
  const signatures = new Map<string, string>();
  const unsubs = [
    bus.subscribe(MessageEvent.PartUpdated, ({ part, delta }) => {
      if (part.sessionId !== sessionId || part.type !== "tool") return;
      const execution = part.metadata?.execution;
      if (execution?.runId !== runId) return;
      const signature = JSON.stringify([
        part.messageId,
        part.callId,
        part.state.status,
        execution.phase,
        execution.waitReason,
        execution.predecessorsKnown,
        [...(execution.blockingCallIds ?? [])].sort(),
        execution.outcome,
        execution.cleanup,
      ]);
      const previous = signatures.get(part.id);
      signatures.set(part.id, signature);
      // A first observed content delta establishes a baseline, not a state transition.
      if (
        previous === signature ||
        (previous === undefined && delta !== undefined)
      )
        return;
      wake();
    }),
    bus.subscribe(PermissionEvent.Updated, ({ info }) => {
      if (info.sessionId === sessionId && info.runId === runId) wake();
    }),
    bus.subscribe(PermissionEvent.Replied, (info) => {
      if (info.sessionId === sessionId && info.runId === runId) wake();
    }),
  ];
  return () => {
    for (const unsubscribe of unsubs) unsubscribe();
  };
}
