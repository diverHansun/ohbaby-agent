import {
  getDatabase,
  schema,
  type DatabaseConnection,
  type SqliteValue,
} from "../../services/database/index.js";
import type { SubagentRole } from "../roles.js";
import {
  assertSubagentInstanceUpdate,
  type QueuedSubagentInput,
  type MarkSubagentsInterruptedInput,
  type SubagentInstanceRecord,
  type SubagentInstanceStatus,
  type SubagentInstanceStore,
  type SubagentInstanceUpdate,
  type SubagentLookupInput,
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
  readonly current_input: string | null;
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

function decodeInput(value: string | null): QueuedSubagentInput | undefined {
  if (value === null) {
    return undefined;
  }
  const decoded = JSON.parse(value) as unknown;
  return typeof decoded === "object" && decoded !== null
    ? (decoded as QueuedSubagentInput)
    : undefined;
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
    currentInput: decodeInput(row.current_input),
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
  if (row.owner_pid === null) {
    return input.recoverUnknownOwner === true;
  }
  return !isOwnerAlive(row.owner_pid);
}

function updateColumns(update: SubagentInstanceUpdate): {
  readonly assignments: string[];
  readonly values: SqliteValue[];
} {
  assertSubagentInstanceUpdate(update);
  const table = schema.subagentInstance.columns;
  const pairs: [string, SqliteValue][] = [];
  const add = (column: string, value: SqliteValue): void => {
    pairs.push([column, value]);
  };

  if (update.status !== undefined) add(table.status, update.status);
  if ("output" in update) add(table.output, update.output ?? null);
  if ("error" in update) add(table.error, update.error ?? null);
  if ("pendingQueue" in update) {
    add(table.pendingQueue, encodeQueue(update.pendingQueue ?? []));
  }
  if ("currentInput" in update) {
    add(
      table.currentInput,
      update.currentInput === undefined
        ? null
        : JSON.stringify(update.currentInput),
    );
  }
  if ("currentRunId" in update) {
    add(table.currentRunId, update.currentRunId ?? null);
  }
  if ("lastRunId" in update) add(table.lastRunId, update.lastRunId ?? null);
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
           pending_queue, current_input, current_run_id, last_run_id, timeout_ms, owner_id,
           owner_pid,
           created_at, updated_at, started_at, completed_at, interrupted_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.currentInput === undefined
          ? null
          : JSON.stringify(record.currentInput),
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

  async claim(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord | null> {
    await Promise.resolve();
    const { assignments, values } = updateColumns(update);
    if (assignments.length === 0) {
      throw new Error("Subagent claim requires an update");
    }
    const row = this.db
      .prepare<SubagentInstanceRow>(
        `UPDATE ${schema.subagentInstance.tableName}
         SET ${assignments.join(", ")}
         WHERE subagent_id = ?
           AND closed_at IS NULL
           AND status NOT IN ('running', 'cancelled')
         RETURNING *`,
      )
      .get(...values, subagentId);
    return row ? rowToRecord(row) : null;
  }

  async finishRun(
    subagentId: string,
    currentRunId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord> {
    await Promise.resolve();
    const { assignments, values } = updateColumns(update);
    if (assignments.length === 0) {
      throw new Error("Subagent run finish requires an update");
    }
    const row = this.db
      .prepare<SubagentInstanceRow>(
        `UPDATE ${schema.subagentInstance.tableName}
         SET ${assignments.join(", ")}
         WHERE subagent_id = ?
           AND closed_at IS NULL
           AND current_run_id IS ?
         RETURNING *`,
      )
      .get(...values, subagentId, currentRunId);
    return row ? rowToRecord(row) : await this.getById(subagentId);
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
    return await this.getById(subagentId);
  }

  private async getById(subagentId: string): Promise<SubagentInstanceRecord> {
    await Promise.resolve();
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
    const interruptedRows: SubagentInstanceRow[] = [];
    for (const row of rowsToInterrupt) {
      const result = this.db
        .prepare(
          `UPDATE ${schema.subagentInstance.tableName}
           SET status = 'interrupted',
               interrupted_at = ?,
               updated_at = ?,
               completed_at = CASE
                 WHEN current_run_id IS NULL THEN completed_at
                 ELSE ?
               END,
               last_run_id = COALESCE(current_run_id, last_run_id),
               current_run_id = NULL
           WHERE subagent_id = ?
             AND status IN ('pending', 'running')
             AND owner_id IS ?
             AND owner_pid IS ?
             AND current_run_id IS ?`,
        )
        .run(
          interruptedAt,
          interruptedAt,
          interruptedAt,
          row.subagent_id,
          row.owner_id,
          row.owner_pid,
          row.current_run_id,
        );
      if (result.changes > 0) {
        interruptedRows.push(row);
      }
    }
    return interruptedRows.map((row) =>
      rowToRecord({
        ...row,
        completed_at:
          row.current_run_id === null ? row.completed_at : interruptedAt,
        current_run_id: null,
        interrupted_at: interruptedAt,
        last_run_id: row.current_run_id ?? row.last_run_id,
        status: "interrupted",
        updated_at: interruptedAt,
      }),
    );
  }
}
