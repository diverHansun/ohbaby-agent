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
interface RecoveredCleanup {
  readonly jobId: string;
  readonly rootSessionId: string;
  readonly workspaceKey: string | null;
  readonly observers: {
    readonly source: WeakRef<object>;
    readonly unresolved: (source: object, jobId: string) => boolean;
  }[];
}
// Group by database identity so a different database cannot release a guard.
const recovered = new Map<string | symbol, Map<string, RecoveredCleanup>>();
const memoryNamespaces = new WeakMap<object, symbol>();
function namespaceKey(namespace: string | object): string | symbol {
  if (typeof namespace === "string") return namespace;
  let key = memoryNamespaces.get(namespace);
  if (!key) {
    key = Symbol("shell cleanup database");
    memoryNamespaces.set(namespace, key);
  }
  return key;
}
function addObserver(
  entry: RecoveredCleanup,
  source: object,
  unresolved: (source: object, jobId: string) => boolean,
): void {
  for (let i = entry.observers.length - 1; i >= 0; i--)
    if (!entry.observers[i]?.source.deref()) entry.observers.splice(i, 1);
  if (!entry.observers.some((observer) => observer.source.deref() === source))
    entry.observers.push({ source: new WeakRef(source), unresolved });
}
export function retainRecoveredSourceCleanup(input: {
  readonly namespace: string | object;
  readonly jobId: string;
  readonly rootSessionId: string;
  readonly workspaceKey: string | null;
  readonly source: object;
  readonly unresolved: (source: object, jobId: string) => boolean;
}): void {
  const key = namespaceKey(input.namespace);
  const group = recovered.get(key) ?? new Map<string, RecoveredCleanup>();
  recovered.set(key, group);
  const id = JSON.stringify([input.rootSessionId, input.jobId]);
  let entry = group.get(id);
  const created = entry === undefined;
  if (!entry) {
    entry = {
      jobId: input.jobId,
      rootSessionId: input.rootSessionId,
      workspaceKey: input.workspaceKey,
      observers: [],
    };
    group.set(id, entry);
  }
  addObserver(entry, input.source, input.unresolved);
  if (created) wakeResourceWaiters();
}
/** Reattach unresolved guards even when their row has since settled or been deleted. */
export function rebindRecoveredSourceCleanup(
  namespace: string | object,
  source: object,
  unresolved: (source: object, jobId: string) => boolean,
): void {
  for (const entry of recovered.get(namespaceKey(namespace))?.values() ?? [])
    addObserver(entry, source, unresolved);
}
export function releaseRecoveredSourceCleanup(
  namespace: string | object,
  rootSessionId: string,
  jobId: string,
): void {
  const key = namespaceKey(namespace);
  const group = recovered.get(key);
  if (!group?.delete(JSON.stringify([rootSessionId, jobId]))) return;
  if (!group.size) recovered.delete(key);
  wakeResourceWaiters();
}
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
  const root = owner.rootSessionId ?? owner.sessionId;
  const workspace = owner.workspaceKey ?? owner.scopeKey ?? "";
  for (const [namespace, group] of recovered) {
    for (const [id, record] of group) {
      let resolved = false;
      for (let i = record.observers.length - 1; i >= 0; i--)
        if (!record.observers[i]?.source.deref()) record.observers.splice(i, 1);
      for (const observer of record.observers) {
        const source = observer.source.deref();
        if (!source) continue;
        try {
          if (!observer.unresolved(source, record.jobId)) {
            resolved = true;
            break;
          }
        } catch {
          /* A closed or unavailable store cannot release responsibility. */
        }
      }
      if (resolved) {
        group.delete(id);
        continue;
      }
      if (
        record.rootSessionId === root &&
        (record.workspaceKey === null || record.workspaceKey === workspace)
      )
        return "unconfirmed";
    }
    if (!group.size) recovered.delete(namespace);
  }
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
