import {
  getDatabase,
  schema,
  type DatabaseConnection,
  type SqliteValue,
} from "../../services/database/index.js";
import type { SubagentRole } from "../roles.js";
import type {
  QueuedSubagentInput,
  MarkSubagentsInterruptedInput,
  SubagentInstanceRecord,
  SubagentInstanceStatus,
  SubagentInstanceStore,
  SubagentInstanceUpdate,
  SubagentLookupInput,
} from "./types.js";

interface SubagentInstanceRow {
  readonly subagent_id: string;
  readonly session_id: string;
  readonly context_scope_id: string;
  readonly parent_session_id: string;
  readonly role: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly initial_prompt: string;
  readonly status: string;
  readonly output: string | null;
  readonly error: string | null;
  readonly pending_queue: string;
  readonly current_run_id: string | null;
  readonly last_run_id: string | null;
  readonly timeout_ms: number | null;
  readonly owner_id: string | null;
  readonly owner_pid: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly interrupted_at: number | null;
  readonly closed_at: number | null;
}

export interface DatabaseSubagentInstanceStoreOptions {
  readonly db?: DatabaseConnection;
  readonly isOwnerAlive?: (pid: number) => boolean;
}

function optional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

function encodeQueue(queue: readonly QueuedSubagentInput[]): string {
  return JSON.stringify(queue);
}

function decodeQueue(value: string): readonly QueuedSubagentInput[] {
  const decoded = JSON.parse(value) as unknown;
  return Array.isArray(decoded) ? (decoded as QueuedSubagentInput[]) : [];
}

function rowToRecord(row: SubagentInstanceRow): SubagentInstanceRecord {
  return {
    subagentId: row.subagent_id,
    sessionId: row.session_id,
    contextScopeId: row.context_scope_id,
    parentSessionId: row.parent_session_id,
    role: row.role as SubagentRole,
    name: optional(row.name),
    description: optional(row.description),
    initialPrompt: row.initial_prompt,
    status: row.status as SubagentInstanceStatus,
    output: optional(row.output),
    error: optional(row.error),
    pendingQueue: decodeQueue(row.pending_queue),
    currentRunId: optional(row.current_run_id),
    lastRunId: optional(row.last_run_id),
    timeoutMs: optional(row.timeout_ms),
    ownerId: optional(row.owner_id),
    ownerPid: optional(row.owner_pid),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: optional(row.started_at),
    completedAt: optional(row.completed_at),
    interruptedAt: optional(row.interrupted_at),
    closedAt: optional(row.closed_at),
  };
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
  row: SubagentInstanceRow,
  input: MarkSubagentsInterruptedInput,
  isOwnerAlive: (pid: number) => boolean,
): boolean {
  if (input.ownerId !== undefined && row.owner_id === input.ownerId) {
    return true;
  }
  if (input.ownerPid !== undefined && row.owner_pid === input.ownerPid) {
    return true;
  }
  if (row.owner_pid === null) {
    return input.recoverUnknownOwner === true;
  }
  return !isOwnerAlive(row.owner_pid);
}

function updateColumns(update: SubagentInstanceUpdate): {
  readonly assignments: string[];
  readonly values: SqliteValue[];
} {
  const table = schema.subagentInstance.columns;
  const pairs: [string, SqliteValue][] = [];
  const add = (column: string, value: SqliteValue): void => {
    pairs.push([column, value]);
  };

  if (update.sessionId !== undefined) add(table.sessionId, update.sessionId);
  if (update.contextScopeId !== undefined) {
    add(table.contextScopeId, update.contextScopeId);
  }
  if (update.parentSessionId !== undefined) {
    add(table.parentSessionId, update.parentSessionId);
  }
  if (update.role !== undefined) add(table.role, update.role);
  if ("name" in update) add(table.name, update.name ?? null);
  if ("description" in update) {
    add(table.description, update.description ?? null);
  }
  if (update.initialPrompt !== undefined) {
    add(table.initialPrompt, update.initialPrompt);
  }
  if (update.status !== undefined) add(table.status, update.status);
  if ("output" in update) add(table.output, update.output ?? null);
  if ("error" in update) add(table.error, update.error ?? null);
  if ("pendingQueue" in update) {
    add(table.pendingQueue, encodeQueue(update.pendingQueue ?? []));
  }
  if ("currentRunId" in update) {
    add(table.currentRunId, update.currentRunId ?? null);
  }
  if ("lastRunId" in update) add(table.lastRunId, update.lastRunId ?? null);
  if ("timeoutMs" in update) add(table.timeoutMs, update.timeoutMs ?? null);
  if ("ownerId" in update) add(table.ownerId, update.ownerId ?? null);
  if ("ownerPid" in update) add(table.ownerPid, update.ownerPid ?? null);
  if (update.updatedAt !== undefined) add(table.updatedAt, update.updatedAt);
  if ("startedAt" in update) add(table.startedAt, update.startedAt ?? null);
  if ("completedAt" in update) {
    add(table.completedAt, update.completedAt ?? null);
  }
  if ("interruptedAt" in update) {
    add(table.interruptedAt, update.interruptedAt ?? null);
  }
  if ("closedAt" in update) add(table.closedAt, update.closedAt ?? null);

  return {
    assignments: pairs.map(([column]) => `${column} = ?`),
    values: pairs.map(([, value]) => value),
  };
}

export class DatabaseSubagentInstanceStore implements SubagentInstanceStore {
  private readonly db: DatabaseConnection;
  private readonly isOwnerAlive: (pid: number) => boolean;

  constructor(options: DatabaseSubagentInstanceStoreOptions = {}) {
    this.db = options.db ?? getDatabase();
    this.isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
  }

  async create(record: SubagentInstanceRecord): Promise<void> {
    await Promise.resolve();
    const table = schema.subagentInstance;
    this.db
      .prepare(
        `INSERT INTO ${table.tableName}
          (subagent_id, session_id, context_scope_id, parent_session_id, role,
           name, description, initial_prompt, status, output, error,
           pending_queue, current_run_id, last_run_id, timeout_ms, owner_id,
           owner_pid,
           created_at, updated_at, started_at, completed_at, interrupted_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.subagentId,
        record.sessionId,
        record.contextScopeId,
        record.parentSessionId,
        record.role,
        record.name ?? null,
        record.description ?? null,
        record.initialPrompt,
        record.status,
        record.output ?? null,
        record.error ?? null,
        encodeQueue(record.pendingQueue),
        record.currentRunId ?? null,
        record.lastRunId ?? null,
        record.timeoutMs ?? null,
        record.ownerId ?? null,
        record.ownerPid ?? null,
        record.createdAt,
        record.updatedAt,
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.interruptedAt ?? null,
        record.closedAt ?? null,
      );
  }

  async get(
    input: SubagentLookupInput,
  ): Promise<SubagentInstanceRecord | null> {
    await Promise.resolve();
    const row = this.db
      .prepare<SubagentInstanceRow>(
        `SELECT * FROM ${schema.subagentInstance.tableName}
         WHERE subagent_id = ? AND parent_session_id = ?`,
      )
      .get(input.subagentId, input.parentSessionId);
    return row ? rowToRecord(row) : null;
  }

  async update(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord> {
    await Promise.resolve();
    const { assignments, values } = updateColumns(update);
    if (assignments.length > 0) {
      this.db
        .prepare(
          `UPDATE ${schema.subagentInstance.tableName}
           SET ${assignments.join(", ")}
           WHERE subagent_id = ?`,
        )
        .run(...values, subagentId);
    }
    const row = this.db
      .prepare<SubagentInstanceRow>(
        `SELECT * FROM ${schema.subagentInstance.tableName}
         WHERE subagent_id = ?`,
      )
      .get(subagentId);
    if (!row) {
      throw new Error(`Subagent not found: ${subagentId}`);
    }
    return rowToRecord(row);
  }

  async listByParent(
    parentSessionId: string,
  ): Promise<readonly SubagentInstanceRecord[]> {
    await Promise.resolve();
    return this.db
      .prepare<SubagentInstanceRow>(
        `SELECT * FROM ${schema.subagentInstance.tableName}
         WHERE parent_session_id = ?
         ORDER BY updated_at ASC, subagent_id ASC`,
      )
      .all(parentSessionId)
      .map(rowToRecord);
  }

  async markInterrupted(
    input: MarkSubagentsInterruptedInput = {},
  ): Promise<readonly SubagentInstanceRecord[]> {
    await Promise.resolve();
    const interruptedAt = input.interruptedAt ?? Date.now();
    const where =
      input.parentSessionId === undefined
        ? "status IN ('pending', 'running')"
        : "parent_session_id = ? AND status IN ('pending', 'running')";
    const params =
      input.parentSessionId === undefined ? [] : [input.parentSessionId];
    const activeRows = this.db
      .prepare<SubagentInstanceRow>(
        `SELECT * FROM ${schema.subagentInstance.tableName}
         WHERE ${where}
         ORDER BY updated_at ASC, subagent_id ASC`,
      )
      .all(...params);
    const rowsToInterrupt = activeRows.filter((row) =>
      shouldInterruptActiveOwner(row, input, this.isOwnerAlive),
    );
    for (const row of rowsToInterrupt) {
      this.db
        .prepare(
          `UPDATE ${schema.subagentInstance.tableName}
           SET status = 'interrupted', interrupted_at = ?, updated_at = ?
           WHERE subagent_id = ?`,
        )
        .run(interruptedAt, interruptedAt, row.subagent_id);
    }
    return rowsToInterrupt.map((row) =>
      rowToRecord({
        ...row,
        interrupted_at: interruptedAt,
        status: "interrupted",
        updated_at: interruptedAt,
      }),
    );
  }
}
