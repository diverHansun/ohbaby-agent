import { wakeResourceWaiters } from "./resources.js";
import type { ToolExecutionOwner } from "./types.js";

export type SourceCleanupState = "in-progress" | "unconfirmed";
export interface SourceCleanupHandle {
  markUnconfirmed(): void;
  confirm(): void;
}
interface CleanupRecord {
  readonly key: string;
  state: SourceCleanupState;
}
// Process lifetime, independent of schedulers/runs. Each job owns its own record.
const records = new Set<CleanupRecord>();
function sourceKey(owner: ToolExecutionOwner): string {
  // Child scopes can differ within one task tree; workspace identifies its root.
  return JSON.stringify([
    owner.workspaceKey ?? owner.scopeKey ?? "",
    owner.rootSessionId ?? owner.sessionId,
  ]);
}
export function getSourceCleanupState(
  owner: ToolExecutionOwner,
): SourceCleanupState | undefined {
  const key = sourceKey(owner);
  let state: SourceCleanupState | undefined;
  for (const record of records) {
    if (record.key !== key) continue;
    if (record.state === "unconfirmed") return "unconfirmed";
    state = "in-progress";
  }
  return state;
}
export function beginSourceCleanup(
  owner: ToolExecutionOwner,
): SourceCleanupHandle {
  const record: CleanupRecord = { key: sourceKey(owner), state: "in-progress" };
  records.add(record);
  wakeResourceWaiters();
  return Object.freeze({
    markUnconfirmed() {
      if (!records.has(record) || record.state === "unconfirmed") return;
      record.state = "unconfirmed";
      wakeResourceWaiters();
    },
    confirm() {
      if (records.delete(record)) wakeResourceWaiters();
    },
  });
}
export class SourceCleanupUnavailableError extends Error {
  constructor() {
    super(
      "Tool not executed: resource temporarily unavailable; a previous operation has unconfirmed cleanup and related resources remain protected. Continue independent work; do not automatically retry.",
    );
    this.name = "SourceCleanupUnavailableError";
  }
}
