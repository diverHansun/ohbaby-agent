/* eslint-disable @typescript-eslint/require-await -- SQLite operations are synchronous behind the shared async store contract. */
import type { UiPromptError } from "ohbaby-sdk";
import {
  getDatabase,
  runWithBusyRetry,
  schema,
  type DatabaseConnection,
} from "../../services/database/index.js";
import {
  InvalidPromptTransitionError,
  PromptNotQueuedError,
  PromptQueueFullError,
  PromptSubmissionNotFoundError,
  PromptVersionConflictError,
} from "./errors.js";
import type {
  AcceptPromptSubmissionInput,
  FinishPromptSubmissionInput,
  PromptSubmissionRecord,
  PromptSubmissionStatus,
  PromptSubmissionStore,
} from "./types.js";

interface PromptSubmissionRow {
  readonly prompt_id: string;
  readonly scope_key: string;
  readonly session_id: string;
  readonly user_message_id: string;
  readonly text: string;
  readonly status: PromptSubmissionStatus;
  readonly run_id: string | null;
  readonly owner_id: string | null;
  readonly owner_pid: number | null;
  readonly error_data: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

export interface DatabasePromptSubmissionStoreOptions {
  readonly db?: DatabaseConnection;
  readonly isOwnerAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly ownerId?: string;
  readonly ownerPid?: number;
}

function defaultIsOwnerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code !== "ESRCH";
  }
}

function parseError(value: string | null): UiPromptError | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<UiPromptError>;
    if (
      typeof parsed.code === "string" &&
      typeof parsed.message === "string" &&
      typeof parsed.source === "string" &&
      typeof parsed.retryable === "boolean"
    ) {
      return parsed as UiPromptError;
    }
  } catch {
    // Fall through to a safe compatibility error.
  }
  return {
    code: "UNKNOWN",
    message: "Stored prompt error could not be decoded",
    source: "runtime",
    retryable: false,
  };
}

function rowToRecord(row: PromptSubmissionRow): PromptSubmissionRecord {
  return {
    promptId: row.prompt_id,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    text: row.text,
    status: row.status,
    runId: row.run_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    ownerPid: row.owner_pid ?? undefined,
    error: parseError(row.error_data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  };
}

export class DatabasePromptSubmissionStore implements PromptSubmissionStore {
  private readonly db: DatabaseConnection;
  private readonly now: () => number;
  private readonly isOwnerAlive: (pid: number) => boolean;
  private readonly ownerId: string | undefined;
  private readonly ownerPid: number | undefined;
  private readonly tableName = schema.promptSubmission.tableName;

  constructor(options: DatabasePromptSubmissionStoreOptions = {}) {
    this.db = options.db ?? getDatabase();
    this.now = options.now ?? Date.now;
    this.isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
    this.ownerId = options.ownerId;
    this.ownerPid = options.ownerPid;
  }

  async assertCapacity(
    scopeKey: string,
    maxQueuedPrompts: number,
  ): Promise<void> {
    const count = this.db
      .prepare<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM ${this.tableName}
         WHERE scope_key = ? AND status = 'queued'`,
      )
      .get(scopeKey)?.count;
    if ((count ?? 0) >= maxQueuedPrompts) {
      throw new PromptQueueFullError(scopeKey, maxQueuedPrompts);
    }
  }

  async accept(
    input: AcceptPromptSubmissionInput,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const session = db
        .prepare<{ readonly id: string }>("SELECT id FROM session WHERE id = ?")
        .get(input.sessionId);
      if (!session) {
        throw new Error(
          `Prompt session was not persisted before admission: ${input.sessionId}`,
        );
      }
      const count = db
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM ${this.tableName}
           WHERE scope_key = ? AND status = 'queued'`,
        )
        .get(input.scopeKey)?.count;
      if ((count ?? 0) >= input.maxQueuedPrompts) {
        throw new PromptQueueFullError(input.scopeKey, input.maxQueuedPrompts);
      }
      const at = this.now();
      db.prepare(
        `INSERT INTO ${this.tableName}
          (prompt_id, scope_key, session_id, user_message_id, text, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(
        input.promptId,
        input.scopeKey,
        input.sessionId,
        input.userMessageId,
        input.text,
        at,
        at,
      );
      return this.requireFrom(db, input.promptId);
    });
  }

  async get(promptId: string): Promise<PromptSubmissionRecord | undefined> {
    return this.row(promptId);
  }

  async editQueued(
    promptId: string,
    expectedUpdatedAt: number,
    text: string,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertQueuedVersion(current, expectedUpdatedAt);
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET text = ?, updated_at = ?
           WHERE prompt_id = ? AND status = 'queued' AND updated_at = ?`,
        )
        .run(text, at, promptId, expectedUpdatedAt);
      if (result.changes !== 1) {
        throw new PromptVersionConflictError(promptId);
      }
      return this.requireFrom(db, promptId);
    });
  }

  async cancelQueued(
    promptId: string,
    expectedUpdatedAt: number,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertQueuedVersion(current, expectedUpdatedAt);
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'cancelled', updated_at = ?, ended_at = ?
           WHERE prompt_id = ? AND status = 'queued' AND updated_at = ?`,
        )
        .run(at, at, promptId, expectedUpdatedAt);
      if (result.changes !== 1) {
        throw new PromptVersionConflictError(promptId);
      }
      return this.requireFrom(db, promptId);
    });
  }

  async claim(promptId: string): Promise<PromptSubmissionRecord | null> {
    return this.transaction((db) => {
      const current = this.rowFrom(db, promptId);
      if (current?.status !== "queued") {
        return null;
      }
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'starting', updated_at = ?, started_at = ?,
               owner_id = ?, owner_pid = ?
           WHERE prompt_id = ? AND status = 'queued'`,
        )
        .run(at, at, this.ownerId ?? null, this.ownerPid ?? null, promptId);
      return result.changes === 1 ? this.requireFrom(db, promptId) : null;
    });
  }

  async markRunning(
    promptId: string,
    runId: string,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      if (current.status !== "starting") {
        throw new InvalidPromptTransitionError(
          promptId,
          current.status,
          "running",
        );
      }
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'running', run_id = ?, updated_at = ?
           WHERE prompt_id = ? AND status = 'starting'`,
        )
        .run(runId, at, promptId);
      if (result.changes !== 1) {
        throw new PromptVersionConflictError(promptId);
      }
      return this.requireFrom(db, promptId);
    });
  }

  async requeueBusy(promptId: string): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      if (current.status !== "starting" || current.runId !== undefined) {
        throw new InvalidPromptTransitionError(
          promptId,
          current.status,
          "queued",
        );
      }
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'queued', updated_at = ?, started_at = NULL,
               owner_id = NULL, owner_pid = NULL
           WHERE prompt_id = ? AND status = 'starting' AND run_id IS NULL`,
        )
        .run(this.nextTime(current), promptId);
      if (result.changes !== 1) {
        throw new PromptVersionConflictError(promptId);
      }
      return this.requireFrom(db, promptId);
    });
  }

  async finish(
    promptId: string,
    input: FinishPromptSubmissionInput,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      if (current.status !== "starting" && current.status !== "running") {
        throw new InvalidPromptTransitionError(
          promptId,
          current.status,
          input.status,
        );
      }
      if (
        input.expectedRunId !== undefined &&
        current.runId !== input.expectedRunId
      ) {
        throw new PromptVersionConflictError(promptId);
      }
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = ?, error_data = ?, updated_at = ?, ended_at = ?
           WHERE prompt_id = ?
             AND status IN ('starting', 'running')
             AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)`,
        )
        .run(
          input.status,
          input.error ? JSON.stringify(input.error) : null,
          at,
          at,
          promptId,
          input.expectedRunId ?? null,
          input.expectedRunId ?? null,
        );
      if (result.changes !== 1) {
        throw new PromptVersionConflictError(promptId);
      }
      return this.requireFrom(db, promptId);
    });
  }

  async listQueued(
    scopeKey: string,
  ): Promise<readonly PromptSubmissionRecord[]> {
    return this.db
      .prepare<PromptSubmissionRow>(
        `SELECT * FROM ${this.tableName}
         WHERE scope_key = ? AND status = 'queued'
         ORDER BY created_at ASC, prompt_id ASC`,
      )
      .all(scopeKey)
      .map(rowToRecord);
  }

  async listVisible(
    scopeKey: string,
  ): Promise<readonly PromptSubmissionRecord[]> {
    return this.db
      .prepare<PromptSubmissionRow>(
        `SELECT * FROM ${this.tableName}
         WHERE scope_key = ?
         ORDER BY created_at ASC, prompt_id ASC`,
      )
      .all(scopeKey)
      .map(rowToRecord);
  }

  async listScopesWithQueued(): Promise<readonly string[]> {
    return this.db
      .prepare<{ readonly scope_key: string }>(
        `SELECT DISTINCT scope_key FROM ${this.tableName}
         WHERE status = 'queued' ORDER BY scope_key ASC`,
      )
      .all()
      .map((row) => row.scope_key);
  }

  async recoverInterrupted(scopeKey: string): Promise<number> {
    return this.transaction((db) => {
      const at = this.now();
      const error: UiPromptError = {
        code: "PROCESS_INTERRUPTED",
        message: "Process interrupted before prompt completed",
        source: "runtime",
        retryable: true,
      };
      return db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'interrupted', error_data = ?, updated_at = ?, ended_at = ?
           WHERE scope_key = ? AND status IN ('starting', 'running')`,
        )
        .run(JSON.stringify(error), at, at, scopeKey).changes;
    });
  }

  async recoverAllInterrupted(): Promise<number> {
    return this.transaction((db) => {
      const at = this.now();
      const error: UiPromptError = {
        code: "PROCESS_INTERRUPTED",
        message: "Process interrupted before prompt completed",
        source: "runtime",
        retryable: true,
      };
      const active = db
        .prepare<PromptSubmissionRow>(
          `SELECT * FROM ${this.tableName}
           WHERE status IN ('starting', 'running')`,
        )
        .all();
      let updatedCount = 0;
      for (const row of active) {
        if (row.owner_pid !== null && this.isOwnerAlive(row.owner_pid)) {
          continue;
        }
        updatedCount += db
          .prepare(
            `UPDATE ${this.tableName}
             SET status = 'interrupted', error_data = ?, updated_at = ?, ended_at = ?
             WHERE prompt_id = ? AND status IN ('starting', 'running')`,
          )
          .run(JSON.stringify(error), at, at, row.prompt_id).changes;
      }
      return updatedCount;
    });
  }

  async failQueuedScope(
    scopeKey: string,
    error: UiPromptError,
  ): Promise<number> {
    return this.transaction((db) => {
      const at = this.now();
      return db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'failed', error_data = ?, updated_at = ?, ended_at = ?
           WHERE scope_key = ? AND status = 'queued'`,
        )
        .run(JSON.stringify(error), at, at, scopeKey).changes;
    });
  }

  private row(promptId: string): PromptSubmissionRecord | undefined {
    return this.rowFrom(this.db, promptId);
  }

  private rowFrom(
    db: DatabaseConnection,
    promptId: string,
  ): PromptSubmissionRecord | undefined {
    const row = db
      .prepare<PromptSubmissionRow>(
        `SELECT * FROM ${this.tableName} WHERE prompt_id = ?`,
      )
      .get(promptId);
    return row ? rowToRecord(row) : undefined;
  }

  private requireFrom(
    db: DatabaseConnection,
    promptId: string,
  ): PromptSubmissionRecord {
    const record = this.rowFrom(db, promptId);
    if (!record) {
      throw new PromptSubmissionNotFoundError(promptId);
    }
    return record;
  }

  private assertQueuedVersion(
    record: PromptSubmissionRecord,
    expectedUpdatedAt: number,
  ): void {
    if (record.status !== "queued") {
      throw new PromptNotQueuedError(record.promptId);
    }
    if (record.updatedAt !== expectedUpdatedAt) {
      throw new PromptVersionConflictError(record.promptId);
    }
  }

  private nextTime(record: PromptSubmissionRecord): number {
    return Math.max(this.now(), record.updatedAt + 1);
  }

  private transaction<T>(operation: (db: DatabaseConnection) => T): T {
    return runWithBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(this.db);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
        throw error;
      }
    });
  }
}
