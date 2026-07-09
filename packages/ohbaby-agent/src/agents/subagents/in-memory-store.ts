import type {
  MarkSubagentsInterruptedInput,
  SubagentInstanceRecord,
  SubagentInstanceStore,
  SubagentInstanceUpdate,
  SubagentLookupInput,
} from "./types.js";

export interface InMemorySubagentInstanceStoreOptions {
  readonly isOwnerAlive?: (pid: number) => boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultIsOwnerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function shouldInterruptActiveOwner(
  record: SubagentInstanceRecord,
  input: MarkSubagentsInterruptedInput,
  isOwnerAlive: (pid: number) => boolean,
): boolean {
  if (input.ownerId !== undefined && record.ownerId === input.ownerId) {
    return true;
  }
  if (input.ownerPid !== undefined && record.ownerPid === input.ownerPid) {
    return true;
  }
  if (record.ownerPid === undefined) {
    return input.recoverUnknownOwner === true;
  }
  return !isOwnerAlive(record.ownerPid);
}

export class InMemorySubagentInstanceStore implements SubagentInstanceStore {
  private readonly records = new Map<string, SubagentInstanceRecord>();
  private readonly isOwnerAlive: (pid: number) => boolean;

  constructor(options: InMemorySubagentInstanceStoreOptions = {}) {
    this.isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
  }

  create(record: SubagentInstanceRecord): Promise<void> {
    if (this.records.has(record.subagentId)) {
      return Promise.reject(
        new Error(`Subagent already exists: ${record.subagentId}`),
      );
    }
    for (const existing of this.records.values()) {
      if (
        existing.sessionId === record.sessionId &&
        existing.contextScopeId === record.contextScopeId
      ) {
        return Promise.reject(
          new Error(
            `Context scope already exists in session: ${record.contextScopeId}`,
          ),
        );
      }
    }
    this.records.set(record.subagentId, clone(record));
    return Promise.resolve();
  }

  get(input: SubagentLookupInput): Promise<SubagentInstanceRecord | null> {
    const record = this.records.get(input.subagentId);
    if (record?.parentSessionId !== input.parentSessionId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(clone(record));
  }

  update(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord> {
    const existing = this.records.get(subagentId);
    if (!existing) {
      return Promise.reject(new Error(`Subagent not found: ${subagentId}`));
    }
    const updated = { ...existing, ...update };
    this.records.set(subagentId, clone(updated));
    return Promise.resolve(clone(updated));
  }

  listByParent(
    parentSessionId: string,
  ): Promise<readonly SubagentInstanceRecord[]> {
    return Promise.resolve(
      Array.from(this.records.values())
        .filter((record) => record.parentSessionId === parentSessionId)
        .sort((left, right) =>
          left.updatedAt === right.updatedAt
            ? left.subagentId.localeCompare(right.subagentId)
            : left.updatedAt - right.updatedAt,
        )
        .map(clone),
    );
  }

  markInterrupted(
    input: MarkSubagentsInterruptedInput = {},
  ): Promise<readonly SubagentInstanceRecord[]> {
    const interruptedAt = input.interruptedAt ?? Date.now();
    const changed: SubagentInstanceRecord[] = [];
    for (const record of this.records.values()) {
      if (
        (input.parentSessionId === undefined ||
          record.parentSessionId === input.parentSessionId) &&
        (record.status === "pending" || record.status === "running") &&
        shouldInterruptActiveOwner(record, input, this.isOwnerAlive)
      ) {
        const updated: SubagentInstanceRecord = {
          ...record,
          interruptedAt,
          status: "interrupted",
          updatedAt: interruptedAt,
        };
        this.records.set(record.subagentId, clone(updated));
        changed.push(updated);
      }
    }
    return Promise.resolve(changed.map(clone));
  }
}
