import {
  getDatabase,
  runWriteTransaction,
  schema,
  type DatabaseConnection,
  type SqliteValue,
} from "../services/database/index.js";

export type ShellJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";
export type ShellJobStopReason =
  | "timeout"
  | "user"
  | "model"
  | "owner-ended"
  | "output-limit"
  | "rewound"
  | "session-closed"
  | "shutdown";
export type ShellJobCleanup = "in-progress" | "confirmed" | "unconfirmed";
export interface ShellJobRecord {
  readonly jobId: string;
  readonly sessionId: string;
  readonly contextScopeId: string | null;
  readonly rootSessionId: string;
  readonly rootRunId: string | null;
  readonly runId: string | null;
  readonly messageId: string | null;
  readonly callId: string | null;
  readonly mode: "foreground" | "background";
  readonly command: string;
  readonly description: string | null;
  readonly cwd: string;
  readonly shell: string;
  readonly timeoutMs: number | null;
  readonly status: ShellJobStatus | null;
  readonly stopReason: ShellJobStopReason | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly processStartToken: string | null;
  readonly recoveryClaim: string | null;
  readonly ownerPid: number | null;
  readonly ownerId: string | null;
  readonly ownerStartToken: string | null;
  readonly goalId: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly settledAt: number | null;
  readonly resultReadyAt: number | null;
  readonly outputPath: string | null;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly outputTail: string | null;
  readonly outputCheckpointAt: number | null;
  readonly outputComplete: boolean | null;
  readonly cleanup: ShellJobCleanup | null;
  readonly trackingReleasedAt: number | null;
  readonly noticeState: "pending" | "accepted" | "suppressed" | null;
  readonly noticeBatchId: string | null;
  readonly noticePayload: string | null;
  readonly noticeInputId: string | null;
  readonly noticeWakeRunId: string | null;
}
export type ShellJobPatch = Partial<Omit<ShellJobRecord, "jobId">>;
function definedPatch(patch: ShellJobPatch): ShellJobPatch {
  return Object.fromEntries(
    Object.entries<unknown>(patch).filter(([, field]) => field !== undefined),
  );
}
export interface ShellJobReservationOptions {
  readonly maxBackgroundJobs?: number;
  /** Synchronous check inside the acquired write lock, before reserving capacity. */
  readonly assertAdmitted?: () => undefined;
}
export class ShellJobCapacityError extends Error {
  readonly code = "SHELL_JOB_CAPACITY_LIMIT";
  constructor(
    readonly limit: number,
    readonly active: number,
  ) {
    super(
      `Background task capacity reached (${String(active)}/${String(limit)} tasks for this owner). Inspect or stop an existing task before starting another.`,
    );
    this.name = "ShellJobCapacityError";
  }
}
function holdsBackgroundSlot(row: ShellJobRecord): boolean {
  return (
    row.mode === "background" &&
    row.trackingReleasedAt === null &&
    (row.status === null ||
      row.status === "running" ||
      row.cleanup !== "confirmed")
  );
}
export interface ShellJobStore {
  insert(
    record: ShellJobRecord,
    options?: ShellJobReservationOptions,
  ): Promise<void>;
  update(jobId: string, patch: ShellJobPatch): Promise<void>;
  get(jobId: string): ShellJobRecord | null;
  compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
  ): Promise<boolean>;
  listUnsettled(rootSessionId?: string): readonly ShellJobRecord[];
  listByRootRun(rootRunId: string): readonly ShellJobRecord[];
  listByOwner(
    sessionId: string,
    contextScopeId: string | null,
  ): readonly ShellJobRecord[];
}
export class InMemoryShellJobStore implements ShellJobStore {
  private readonly records = new Map<string, ShellJobRecord>();
  insert(
    record: ShellJobRecord,
    options: ShellJobReservationOptions = {},
  ): Promise<void> {
    return Promise.resolve().then(() => {
      options.assertAdmitted?.();
      if (
        record.mode === "background" &&
        options.maxBackgroundJobs !== undefined
      ) {
        const active = this.listByOwner(
          record.sessionId,
          record.contextScopeId,
        ).filter(holdsBackgroundSlot).length;
        if (active >= options.maxBackgroundJobs)
          throw new ShellJobCapacityError(options.maxBackgroundJobs, active);
      }
      if (this.records.has(record.jobId))
        throw new Error("Shell job identity already exists.");
      this.records.set(record.jobId, { ...record });
    });
  }
  update(jobId: string, patch: ShellJobPatch): Promise<void> {
    const current = this.records.get(jobId);
    if (!current)
      return Promise.reject(new Error(`Unknown shell job "${jobId}".`));
    this.records.set(jobId, { ...current, ...definedPatch(patch) });
    return Promise.resolve();
  }
  compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
  ): Promise<boolean> {
    patch = definedPatch(patch);
    expected = definedPatch(expected);
    if (Object.keys(patch).length === 0)
      return Promise.reject(new Error("Shell job CAS requires an update."));
    const row = this.records.get(jobId);
    if (
      !row ||
      !(Object.keys(expected) as (keyof ShellJobPatch)[]).every(
        (key) => row[key] === expected[key],
      )
    )
      return Promise.resolve(false);
    this.records.set(jobId, { ...row, ...patch });
    return Promise.resolve(true);
  }
  listUnsettled(rootSessionId?: string): readonly ShellJobRecord[] {
    return [...this.records.values()]
      .filter(
        (row) =>
          (rootSessionId === undefined ||
            row.rootSessionId === rootSessionId) &&
          row.trackingReleasedAt === null &&
          (row.status === null ||
            row.status === "running" ||
            row.cleanup !== "confirmed" ||
            row.settledAt === null),
      )
      .map((row) => ({ ...row }));
  }
  get(jobId: string): ShellJobRecord | null {
    const row = this.records.get(jobId);
    return row ? { ...row } : null;
  }
  listByRootRun(rootRunId: string): readonly ShellJobRecord[] {
    return [...this.records.values()]
      .filter((r) => r.rootRunId === rootRunId)
      .map((r) => ({ ...r }));
  }
  listByOwner(
    sessionId: string,
    contextScopeId: string | null,
  ): readonly ShellJobRecord[] {
    return [...this.records.values()]
      .filter(
        (r) => r.sessionId === sessionId && r.contextScopeId === contextScopeId,
      )
      .map((r) => ({ ...r }));
  }
}
const columns = schema.shellJob.columns;
type Key = keyof typeof columns;
const keys = Object.keys(columns) as Key[];
function value(input: ShellJobRecord[Key]): SqliteValue {
  return typeof input === "boolean" ? Number(input) : input;
}
function fromRow(row: Record<string, unknown>): ShellJobRecord {
  const record: Record<string, unknown> = {};
  for (const key of keys) record[key] = row[columns[key]];
  record.outputTruncated = Boolean(record.outputTruncated);
  if (record.outputComplete !== null)
    record.outputComplete = Boolean(record.outputComplete);
  return record as unknown as ShellJobRecord;
}
export class DatabaseShellJobStore implements ShellJobStore {
  private readonly db: DatabaseConnection;
  constructor(options: { db?: DatabaseConnection } = {}) {
    this.db = options.db ?? getDatabase();
  }
  async insert(
    record: ShellJobRecord,
    options: ShellJobReservationOptions = {},
  ): Promise<void> {
    await runWriteTransaction(this.db, (tx) => {
      options.assertAdmitted?.();
      if (
        record.mode === "background" &&
        options.maxBackgroundJobs !== undefined
      ) {
        const row = tx
          .prepare<{
            count: number;
          }>(
            "SELECT count(*) AS count FROM shell_job WHERE session_id = ? AND context_scope_id IS ? AND mode = 'background' AND tracking_released_at IS NULL AND (status IS NULL OR status = 'running' OR cleanup IS NOT 'confirmed')",
          )
          .get(record.sessionId, record.contextScopeId);
        if ((row?.count ?? 0) >= options.maxBackgroundJobs)
          throw new ShellJobCapacityError(
            options.maxBackgroundJobs,
            row?.count ?? 0,
          );
      }
      tx.prepare(
        `INSERT INTO shell_job (${keys.map((key) => columns[key]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      ).run(...keys.map((key) => value(record[key])));
    });
  }
  async update(jobId: string, patch: ShellJobPatch): Promise<void> {
    patch = definedPatch(patch);
    const changed = Object.keys(patch) as Exclude<Key, "jobId">[];
    if (changed.length === 0) return;
    await runWriteTransaction(this.db, (tx) => {
      const result = tx
        .prepare(
          `UPDATE shell_job SET ${changed.map((key) => `${columns[key]} = ?`).join(",")} WHERE job_id = ?`,
        )
        .run(...changed.map((key) => value(patch[key] ?? null)), jobId);
      if (result.changes !== 1)
        throw new Error(`Unknown shell job "${jobId}".`);
    });
  }
  get(jobId: string): ShellJobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM shell_job WHERE job_id = ?")
      .get(jobId);
    return row ? fromRow(row) : null;
  }
  async compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
  ): Promise<boolean> {
    patch = definedPatch(patch);
    expected = definedPatch(expected);
    const changed = Object.keys(patch) as (keyof ShellJobPatch)[];
    const compared = Object.keys(expected) as (keyof ShellJobPatch)[];
    if (changed.length === 0)
      throw new Error("Shell job CAS requires an update.");
    return runWriteTransaction(this.db, (tx) => {
      const result = tx
        .prepare(
          `UPDATE shell_job SET ${changed.map((key) => `${columns[key]} = ?`).join(",")} WHERE job_id = ?${compared.map((key) => ` AND ${columns[key]} IS ?`).join("")}`,
        )
        .run(
          ...changed.map((key) => value(patch[key] ?? null)),
          jobId,
          ...compared.map((key) => value(expected[key] ?? null)),
        );
      return result.changes === 1;
    });
  }
  listUnsettled(rootSessionId?: string): readonly ShellJobRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM shell_job WHERE tracking_released_at IS NULL AND (status IS NULL OR status = 'running' OR cleanup IS NOT 'confirmed' OR settled_at IS NULL)${rootSessionId === undefined ? "" : " AND root_session_id = ?"} ORDER BY created_at,job_id`,
      )
      .all(...(rootSessionId === undefined ? [] : [rootSessionId]))
      .map(fromRow);
  }
  listByRootRun(rootRunId: string): readonly ShellJobRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM shell_job WHERE root_run_id = ? ORDER BY created_at,job_id",
      )
      .all(rootRunId)
      .map(fromRow);
  }
  listByOwner(
    sessionId: string,
    contextScopeId: string | null,
  ): readonly ShellJobRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM shell_job WHERE session_id = ? AND context_scope_id IS ? ORDER BY created_at,job_id",
      )
      .all(sessionId, contextScopeId)
      .map(fromRow);
  }
}
