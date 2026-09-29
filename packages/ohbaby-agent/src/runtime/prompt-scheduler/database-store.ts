import { sameReasoning } from "./types.js";
/* eslint-disable @typescript-eslint/require-await -- SQLite operations are synchronous behind the shared async store contract. */
import { randomUUID } from "node:crypto";
import type { UiPromptError } from "ohbaby-sdk";
import { isValidOwnerPid } from "../../utils/process-owner.js";
import {
  getDatabase,
  runWriteTransaction,
  schema,
  type DatabaseConnection,
} from "../../services/database/index.js";
import {
  InvalidPromptClientRequestIdError,
  InvalidPromptTransitionError,
  PromptEditLeaseHeldError,
  PromptEditLeaseLostError,
  PromptIdempotencyConflictError,
  PromptNotQueuedError,
  PromptQueueFullError,
  PromptSubmissionNotFoundError,
  PromptVersionConflictError,
} from "./errors.js";
import type {
  AcceptPromptSubmissionInput,
  AcceptPromptSubmissionResult,
  FinishPromptSubmissionInput,
  PromptEditLease,
  PromptSubmissionRecord,
  PromptHistoryWindow,
  PromptSubmissionStatus,
  PromptSubmissionStore,
  PromptResubmissionReceipt,
  ResubmitRetainedPromptInput,
  ResubmitRetainedPromptResult,
  RecoverPromptSubmissionsOptions,
} from "./types.js";

export interface PromptSubmissionRow {
  readonly steer_receipt: string | null;
  readonly prompt_id: string;
  readonly client_request_id: string;
  readonly scope_key: string;
  readonly session_id: string;
  readonly user_message_id: string;
  readonly text: string;
  readonly reasoning_data: string | null;
  readonly naming_source: string | null;
  readonly title_expected: string | null;
  readonly status: PromptSubmissionStatus;
  readonly run_id: string | null;
  readonly owner_id: string | null;
  readonly owner_pid: number | null;
  readonly edit_lease_id: string | null;
  readonly edit_lease_owner_id: string | null;
  readonly edit_lease_expires_at: number | null;
  readonly error_data: string | null;
  readonly accepted_at: number;
  readonly admission_order: number;
  readonly end_time_source: "recovery" | null;
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
  if (!isValidOwnerPid(pid)) {
    return true;
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

export function promptSubmissionRowToRecord(
  row: PromptSubmissionRow,
): PromptSubmissionRecord {
  return {
    promptId: row.prompt_id,
    steerReceipt: row.steer_receipt
      ? (JSON.parse(
          row.steer_receipt,
        ) as PromptSubmissionRecord["steerReceipt"])
      : undefined,
    clientRequestId: row.client_request_id,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    text: row.text,
    titleExpected: row.title_expected ?? undefined,
    namingSource: row.naming_source
      ? (JSON.parse(
          row.naming_source,
        ) as PromptSubmissionRecord["namingSource"])
      : undefined,
    reasoning: row.reasoning_data
      ? (JSON.parse(row.reasoning_data) as PromptSubmissionRecord["reasoning"])
      : undefined,
    status: row.status,
    runId: row.run_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    ownerPid: row.owner_pid ?? undefined,
    editLeaseId: row.edit_lease_id ?? undefined,
    editLeaseOwnerId: row.edit_lease_owner_id ?? undefined,
    editLeaseExpiresAt: row.edit_lease_expires_at ?? undefined,
    error: parseError(row.error_data),
    acceptedAt: row.accepted_at,
    admissionOrder: row.admission_order,
    endTimeSource: row.end_time_source ?? undefined,
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
  private readonly ownerId: string;
  private readonly ownerPid: number;
  private readonly tableName = schema.promptSubmission.tableName;

  constructor(options: DatabasePromptSubmissionStoreOptions = {}) {
    this.db = options.db ?? getDatabase();
    this.now = options.now ?? Date.now;
    this.isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
    this.ownerId = options.ownerId ?? `owner_${randomUUID()}`;
    this.ownerPid = options.ownerPid ?? process.pid;
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
  ): Promise<AcceptPromptSubmissionResult> {
    if (
      input.clientRequestId.trim() === "" ||
      input.clientRequestId.startsWith("legacy:")
    ) {
      throw new InvalidPromptClientRequestIdError(input.clientRequestId);
    }
    return this.transaction((db) => {
      const existing = this.rowByClientRequestFrom(
        db,
        input.scopeKey,
        input.clientRequestId,
      );
      if (existing) {
        if (
          existing.sessionId !== input.sessionId ||
          existing.text !== input.text ||
          !sameReasoning(existing.reasoning, input.reasoning)
        ) {
          throw new PromptIdempotencyConflictError(input.clientRequestId);
        }
        return { record: existing, inserted: false };
      }
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
      const latestCreatedAt = db
        .prepare<{ readonly created_at: number | null }>(
          `SELECT MAX(created_at) AS created_at FROM ${this.tableName}
           WHERE scope_key = ?`,
        )
        .get(input.scopeKey)?.created_at;
      const at = Math.max(
        this.now(),
        (latestCreatedAt ?? 0) + 1,
        this.latestAcceptedAt(db, input.scopeKey),
      );
      db.prepare(
        `INSERT INTO ${this.tableName}
          (prompt_id, client_request_id, scope_key, session_id,
           user_message_id, text, reasoning_data, naming_source, title_expected, status,
           created_at, updated_at, owner_id, owner_pid, accepted_at, admission_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.promptId,
        input.clientRequestId,
        input.scopeKey,
        input.sessionId,
        input.userMessageId,
        input.text,
        input.reasoning ? JSON.stringify(input.reasoning) : null,
        input.namingSource ? JSON.stringify(input.namingSource) : null,
        input.titleExpected ?? null,
        at,
        at,
        this.ownerId,
        this.ownerPid,
        at,
        this.nextAdmissionOrder(db, input.scopeKey),
      );
      return { record: this.requireFrom(db, input.promptId), inserted: true };
    });
  }

  async get(promptId: string): Promise<PromptSubmissionRecord | undefined> {
    return this.row(promptId);
  }

  async getByClientRequestId(
    scopeKey: string,
    clientRequestId: string,
  ): Promise<PromptSubmissionRecord | undefined> {
    return this.rowByClientRequestFrom(this.db, scopeKey, clientRequestId);
  }

  async acquireEditLease(
    promptId: string,
    ownerClientId: string,
    ttlMs: number,
  ): Promise<PromptEditLease> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertQueued(current);
      const now = this.now();
      if (
        current.editLeaseId !== undefined &&
        (current.editLeaseExpiresAt ?? 0) > now
      ) {
        throw new PromptEditLeaseHeldError(promptId);
      }
      const editLeaseId = `lease_${randomUUID()}`;
      const expiresAt = now + ttlMs;
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET edit_lease_id = ?, edit_lease_owner_id = ?,
               edit_lease_expires_at = ?, updated_at = ?
           WHERE prompt_id = ? AND status IN ('queued', 'retained')
             AND (edit_lease_id IS NULL OR edit_lease_expires_at <= ?)`,
        )
        .run(
          editLeaseId,
          ownerClientId,
          expiresAt,
          this.nextTime(current),
          promptId,
          now,
        );
      if (result.changes !== 1) {
        throw new PromptEditLeaseHeldError(promptId);
      }
      return {
        editLeaseId,
        ownerClientId,
        expiresAt,
        prompt: this.requireFrom(db, promptId),
      };
    });
  }

  async renewEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId: string,
    ttlMs: number,
  ): Promise<PromptEditLease> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertLease(current, editLeaseId, ownerClientId);
      const expiresAt = this.now() + ttlMs;
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET edit_lease_owner_id = ?, edit_lease_expires_at = ?,
               updated_at = ?
           WHERE prompt_id = ? AND status IN ('queued', 'retained')
             AND edit_lease_id = ? AND edit_lease_owner_id = ?
             AND edit_lease_expires_at > ?`,
        )
        .run(
          ownerClientId,
          expiresAt,
          this.nextTime(current),
          promptId,
          editLeaseId,
          ownerClientId,
          this.now(),
        );
      if (result.changes !== 1) {
        throw new PromptEditLeaseLostError(promptId);
      }
      return {
        editLeaseId,
        ownerClientId,
        expiresAt,
        prompt: this.requireFrom(db, promptId),
      };
    });
  }

  async commitEdit(
    promptId: string,
    editLeaseId: string,
    text: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    return this.updateWithLease(
      promptId,
      editLeaseId,
      ownerClientId,
      (db, current) => {
        const result = db
          .prepare(
            `UPDATE ${this.tableName}
           SET naming_source = CASE WHEN text = ? THEN naming_source ELSE NULL END,
               text = ?, edit_lease_id = NULL,
               edit_lease_owner_id = NULL, edit_lease_expires_at = NULL,
               updated_at = ?
           WHERE prompt_id = ? AND status IN ('queued', 'retained')
             AND edit_lease_id = ? AND edit_lease_expires_at > ?
             AND (? IS NULL OR edit_lease_owner_id = ?)`,
          )
          .run(
            text,
            text,
            this.nextTime(current),
            promptId,
            editLeaseId,
            this.now(),
            ownerClientId ?? null,
            ownerClientId ?? null,
          );
        if (result.changes !== 1) {
          throw new PromptEditLeaseLostError(promptId);
        }
      },
    );
  }

  async releaseEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    return this.updateWithLease(
      promptId,
      editLeaseId,
      ownerClientId,
      (db, current) => {
        const result = db
          .prepare(
            `UPDATE ${this.tableName}
           SET edit_lease_id = NULL, edit_lease_owner_id = NULL,
               edit_lease_expires_at = NULL, updated_at = ?
           WHERE prompt_id = ? AND status IN ('queued', 'retained')
             AND edit_lease_id = ? AND edit_lease_expires_at > ?
             AND (? IS NULL OR edit_lease_owner_id = ?)`,
          )
          .run(
            this.nextTime(current),
            promptId,
            editLeaseId,
            this.now(),
            ownerClientId ?? null,
            ownerClientId ?? null,
          );
        if (result.changes !== 1) {
          throw new PromptEditLeaseLostError(promptId);
        }
      },
    );
  }

  async cancelQueued(
    promptId: string,
    editLeaseId?: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertQueued(current);
      const now = this.now();
      if ((current.editLeaseExpiresAt ?? 0) > now) {
        if (editLeaseId === undefined) {
          throw new PromptEditLeaseHeldError(promptId);
        }
        this.assertLease(current, editLeaseId, ownerClientId);
      }
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'cancelled', updated_at = ?, ended_at = ?,
               edit_lease_id = NULL, edit_lease_owner_id = NULL,
               edit_lease_expires_at = NULL
           WHERE prompt_id = ? AND status IN ('queued', 'retained')
             AND (edit_lease_id IS NULL OR edit_lease_expires_at <= ?
                  OR (edit_lease_id = ?
                      AND (? IS NULL OR edit_lease_owner_id = ?)))`,
        )
        .run(
          at,
          at,
          promptId,
          now,
          editLeaseId ?? null,
          ownerClientId ?? null,
          ownerClientId ?? null,
        );
      if (result.changes !== 1) {
        throw new PromptEditLeaseLostError(promptId);
      }
      return this.requireFrom(db, promptId);
    });
  }

  async claim(promptId: string): Promise<PromptSubmissionRecord | null> {
    return this.transaction((db) => {
      const current = this.rowFrom(db, promptId);
      if (current?.status !== "queued" || !this.owns(current)) {
        return null;
      }
      const now = this.now();
      if ((current.editLeaseExpiresAt ?? 0) > now) {
        return null;
      }
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
           SET status = 'starting', updated_at = ?, started_at = ?,
               edit_lease_id = NULL,
               edit_lease_owner_id = NULL, edit_lease_expires_at = NULL
           WHERE prompt_id = ? AND status = 'queued'
             AND owner_id = ? AND owner_pid = ?
             AND (edit_lease_id IS NULL OR edit_lease_expires_at <= ?)`,
        )
        .run(at, at, promptId, this.ownerId, this.ownerPid, now);
      return result.changes === 1 ? this.requireFrom(db, promptId) : null;
    });
  }

  async markRunning(
    promptId: string,
    runId: string,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertOwned(current);
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
      this.assertOwned(current);
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
           SET status = 'queued', updated_at = ?, started_at = NULL
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
      this.assertOwned(current);
      if (
        input.expectedRunId !== undefined &&
        current.runId !== input.expectedRunId
      )
        throw new PromptVersionConflictError(promptId);
      if (
        ["succeeded", "failed", "cancelled", "interrupted"].includes(
          current.status,
        )
      )
        return current;
      if (current.status !== "starting" && current.status !== "running")
        throw new InvalidPromptTransitionError(
          promptId,
          current.status,
          input.status,
        );
      const at = this.nextTime(current);
      const result = db
        .prepare(
          `UPDATE ${this.tableName}
        SET status = ?, error_data = ?, updated_at = ?, ended_at = ?, end_time_source = ?
        WHERE prompt_id = ? AND status IN ('starting', 'running')
          AND owner_id = ? AND owner_pid = ? AND run_id IS ?`,
        )
        .run(
          input.status,
          input.error ? JSON.stringify(input.error) : null,
          at,
          input.endedAt ?? at,
          input.endTimeSource ?? null,
          promptId,
          this.ownerId,
          this.ownerPid,
          current.runId ?? null,
        );
      if (result.changes !== 1) throw new PromptVersionConflictError(promptId);
      return this.requireFrom(db, promptId);
    });
  }

  async listQueued(
    scopeKey: string,
  ): Promise<readonly PromptSubmissionRecord[]> {
    return this.db
      .prepare<PromptSubmissionRow>(
        `SELECT * FROM ${this.tableName}
         WHERE scope_key = ? AND status = 'queued' AND owner_id = ? AND owner_pid = ?
         ORDER BY accepted_at ASC, admission_order ASC, prompt_id ASC`,
      )
      .all(scopeKey, this.ownerId, this.ownerPid)
      .map(promptSubmissionRowToRecord);
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
      .map(promptSubmissionRowToRecord);
  }

  async hasForSession(scopeKey: string, sessionId: string): Promise<boolean> {
    return (
      this.db
        .prepare<{
          present: number;
        }>(
          `SELECT 1 AS present FROM ${this.tableName} WHERE scope_key = ? AND session_id = ? LIMIT 1`,
        )
        .get(scopeKey, sessionId) !== undefined
    );
  }

  async listForSession(
    scopeKey: string,
    sessionId: string,
    window: PromptHistoryWindow = {},
  ): Promise<readonly PromptSubmissionRecord[]> {
    const messageIds = [...new Set(window.messageIds ?? [])];
    const runIds = [...new Set(window.runIds ?? [])];
    const associations = [
      "status IN ('queued', 'retained', 'starting', 'running')",
    ];
    const values: string[] = [scopeKey, sessionId];
    if (messageIds.length > 0) {
      associations.push(
        `user_message_id IN (${messageIds.map(() => "?").join(", ")})`,
      );
      values.push(...messageIds);
    }
    if (runIds.length > 0) {
      associations.push(`run_id IN (${runIds.map(() => "?").join(", ")})`);
      values.push(...runIds);
    }
    return this.db
      .prepare<PromptSubmissionRow>(
        `SELECT * FROM ${this.tableName}
       WHERE scope_key = ? AND session_id = ? AND (${associations.join(" OR ")})
       ORDER BY created_at ASC, prompt_id ASC`,
      )
      .all(...values)
      .map(promptSubmissionRowToRecord);
  }

  async listScopesWithQueued(): Promise<readonly string[]> {
    return this.db
      .prepare<{ readonly scope_key: string }>(
        `SELECT DISTINCT scope_key FROM ${this.tableName}
         WHERE status = 'queued' AND owner_id = ? AND owner_pid = ? ORDER BY scope_key ASC`,
      )
      .all(this.ownerId, this.ownerPid)
      .map((row) => row.scope_key);
  }

  async resubmitRetained(
    input: ResubmitRetainedPromptInput,
  ): Promise<ResubmitRetainedPromptResult> {
    if (!input.operationId.trim() || input.operationId.startsWith("legacy:"))
      throw new InvalidPromptClientRequestIdError(input.operationId);
    return this.transaction((db) => {
      const previous = db
        .prepare<{
          prompt_id: string;
          text: string;
          receipt: string;
        }>(
          "SELECT prompt_id,text,receipt FROM prompt_resubmission WHERE scope_key=? AND operation_id=?",
        )
        .get(input.scopeKey, input.operationId);
      if (previous) {
        if (
          previous.prompt_id !== input.promptId ||
          previous.text !== input.text
        )
          throw new PromptIdempotencyConflictError(input.operationId);
        return {
          record: this.requireFrom(db, input.promptId),
          receipt: JSON.parse(previous.receipt) as PromptResubmissionReceipt,
          inserted: false,
        };
      }
      const current = this.requireFrom(db, input.promptId);
      if (current.scopeKey !== input.scopeKey || current.status !== "retained")
        throw new PromptVersionConflictError(input.promptId);
      this.assertLease(current, input.editLeaseId, input.ownerClientId);
      if (!input.text.trim()) throw new Error("Prompt text must not be empty");
      const count =
        db
          .prepare<{
            count: number;
          }>(
            `SELECT COUNT(*) AS count FROM ${this.tableName} WHERE scope_key=? AND status='queued'`,
          )
          .get(input.scopeKey)?.count ?? 0;
      if (count >= input.maxQueuedPrompts)
        throw new PromptQueueFullError(input.scopeKey, input.maxQueuedPrompts);
      const acceptedAt = Math.max(
        this.now(),
        this.latestAcceptedAt(db, input.scopeKey),
      );
      const order = this.nextAdmissionOrder(db, input.scopeKey);
      const result = db
        .prepare(
          `UPDATE ${this.tableName} SET naming_source=CASE WHEN text=? THEN naming_source ELSE NULL END, text=?, status='queued', owner_id=?, owner_pid=?,
        accepted_at=?, admission_order=?, updated_at=?, run_id=NULL, started_at=NULL, ended_at=NULL,
        end_time_source=NULL, error_data=NULL, edit_lease_id=NULL, edit_lease_owner_id=NULL, edit_lease_expires_at=NULL
        WHERE prompt_id=? AND status='retained' AND edit_lease_id=? AND edit_lease_expires_at>?
          AND (? IS NULL OR edit_lease_owner_id=?)`,
        )
        .run(
          input.text,
          input.text,
          this.ownerId,
          this.ownerPid,
          acceptedAt,
          order,
          this.nextTime(current),
          input.promptId,
          input.editLeaseId,
          this.now(),
          input.ownerClientId ?? null,
          input.ownerClientId ?? null,
        );
      if (result.changes !== 1)
        throw new PromptEditLeaseLostError(input.promptId);
      const receipt: PromptResubmissionReceipt = {
        operationId: input.operationId,
        promptId: current.promptId,
        sessionId: current.sessionId,
        userMessageId: current.userMessageId,
        acceptedAt,
      };
      db.prepare(
        "INSERT INTO prompt_resubmission(scope_key,operation_id,prompt_id,text,receipt) VALUES(?,?,?,?,?)",
      ).run(
        input.scopeKey,
        input.operationId,
        input.promptId,
        input.text,
        JSON.stringify(receipt),
      );
      return {
        record: this.requireFrom(db, input.promptId),
        receipt,
        inserted: true,
      };
    });
  }

  async getResubmissionReceipt(
    scopeKey: string,
    operationId: string,
  ): Promise<PromptResubmissionReceipt | undefined> {
    const row = this.db
      .prepare<{
        receipt: string;
      }>(
        "SELECT receipt FROM prompt_resubmission WHERE scope_key=? AND operation_id=?",
      )
      .get(scopeKey, operationId);
    return row
      ? (JSON.parse(row.receipt) as PromptResubmissionReceipt)
      : undefined;
  }

  async retainOwnedQueued(scopeKey?: string): Promise<number> {
    return this.transaction(
      (db) =>
        db
          .prepare(
            `UPDATE ${this.tableName} SET status='retained', updated_at=?, ended_at=NULL,
      edit_lease_id=NULL, edit_lease_owner_id=NULL, edit_lease_expires_at=NULL
      WHERE status='queued' AND owner_id=? AND owner_pid=? AND (? IS NULL OR scope_key=?)`,
          )
          .run(
            this.now(),
            this.ownerId,
            this.ownerPid,
            scopeKey ?? null,
            scopeKey ?? null,
          ).changes,
    );
  }

  async recoverInterrupted(scopeKey: string): Promise<number> {
    return this.recoverAllInterrupted({ scopeKey });
  }

  async recoverAllInterrupted(
    options: RecoverPromptSubmissionsOptions = {},
  ): Promise<number> {
    return this.transaction((db) => {
      const rows = db
        .prepare<PromptSubmissionRow>(
          `SELECT * FROM ${this.tableName}
        WHERE status IN ('queued','starting','running') AND (? IS NULL OR scope_key=?) AND (? IS NULL OR session_id=?)`,
        )
        .all(
          options.scopeKey ?? null,
          options.scopeKey ?? null,
          options.sessionId ?? null,
          options.sessionId ?? null,
        );
      let count = 0;
      for (const row of rows) {
        const owned =
          row.owner_id === this.ownerId && row.owner_pid === this.ownerPid;
        const unknown = !row.owner_id || !isValidOwnerPid(row.owner_pid);
        const recover = unknown
          ? options.recoverUnknownOwner === true
          : owned
            ? options.includeCurrentOwner === true
            : !this.isOwnerAlive(row.owner_pid);
        if (!recover) continue;
        const retained = row.status === "queued";
        const at = Math.max(this.now(), row.updated_at + 1);
        const error: UiPromptError = {
          code: "PROCESS_INTERRUPTED",
          message: "Process interrupted before prompt completed",
          source: "runtime",
          retryable: true,
        };
        count += db
          .prepare(
            `UPDATE ${this.tableName} SET status=?, error_data=?, updated_at=?, ended_at=?, end_time_source=?,
          edit_lease_id=NULL, edit_lease_owner_id=NULL, edit_lease_expires_at=NULL
          WHERE prompt_id=? AND status=? AND owner_id IS ? AND owner_pid IS ?`,
          )
          .run(
            retained ? "retained" : "interrupted",
            retained ? null : JSON.stringify(error),
            at,
            retained ? null : at,
            retained ? null : "recovery",
            row.prompt_id,
            row.status,
            row.owner_id,
            row.owner_pid,
          ).changes;
      }
      return count;
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
           WHERE scope_key = ? AND status = 'queued' AND owner_id = ? AND owner_pid = ?`,
        )
        .run(
          JSON.stringify(error),
          at,
          at,
          scopeKey,
          this.ownerId,
          this.ownerPid,
        ).changes;
    });
  }

  private owns(record: PromptSubmissionRecord): boolean {
    return record.ownerId === this.ownerId && record.ownerPid === this.ownerPid;
  }
  private assertOwned(record: PromptSubmissionRecord): void {
    if (!this.owns(record))
      throw new PromptVersionConflictError(record.promptId);
  }
  private nextAdmissionOrder(db: DatabaseConnection, scopeKey: string): number {
    return (
      db
        .prepare<{
          value: number;
        }>(
          `SELECT COALESCE(MAX(admission_order),0)+1 AS value FROM ${this.tableName} WHERE scope_key=?`,
        )
        .get(scopeKey)?.value ?? 1
    );
  }
  private latestAcceptedAt(db: DatabaseConnection, scopeKey: string): number {
    return (
      db
        .prepare<{
          value: number;
        }>(
          `SELECT COALESCE(MAX(accepted_at),0) AS value FROM ${this.tableName} WHERE scope_key=?`,
        )
        .get(scopeKey)?.value ?? 0
    );
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
    return row ? promptSubmissionRowToRecord(row) : undefined;
  }

  private rowByClientRequestFrom(
    db: DatabaseConnection,
    scopeKey: string,
    clientRequestId: string,
  ): PromptSubmissionRecord | undefined {
    const row = db
      .prepare<PromptSubmissionRow>(
        `SELECT * FROM ${this.tableName}
         WHERE scope_key = ? AND client_request_id = ?`,
      )
      .get(scopeKey, clientRequestId);
    return row ? promptSubmissionRowToRecord(row) : undefined;
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

  private assertQueued(record: PromptSubmissionRecord): void {
    if (record.status !== "queued" && record.status !== "retained") {
      throw new PromptNotQueuedError(record.promptId);
    }
  }

  private assertLease(
    record: PromptSubmissionRecord,
    editLeaseId: string,
    ownerClientId?: string,
  ): void {
    this.assertQueued(record);
    if (
      record.editLeaseId !== editLeaseId ||
      (ownerClientId !== undefined &&
        record.editLeaseOwnerId !== ownerClientId) ||
      (record.editLeaseExpiresAt ?? 0) <= this.now()
    ) {
      throw new PromptEditLeaseLostError(record.promptId);
    }
  }

  private updateWithLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId: string | undefined,
    update: (db: DatabaseConnection, current: PromptSubmissionRecord) => void,
  ): Promise<PromptSubmissionRecord> {
    return this.transaction((db) => {
      const current = this.requireFrom(db, promptId);
      this.assertLease(current, editLeaseId, ownerClientId);
      update(db, current);
      return this.requireFrom(db, promptId);
    });
  }

  private nextTime(record: PromptSubmissionRecord): number {
    return Math.max(this.now(), record.updatedAt + 1);
  }

  private transaction<T>(operation: (db: DatabaseConnection) => T): Promise<T> {
    return runWriteTransaction(this.db, operation);
  }
}
