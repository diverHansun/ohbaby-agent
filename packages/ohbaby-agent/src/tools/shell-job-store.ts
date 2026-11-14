import {
  isShellJobUnsettled,
  queryMemoryShellJobs,
  queryDatabaseShellJobs,
  type ShellJobQuery,
  type ShellJobPage,
  type ShellJobStatus,
} from "./shell-job-query.js";
import { randomUUID } from "node:crypto";
import { freezeShellJobNoticeBatch } from "./shell-job-notice.js";
import {
  getDatabase,
  runWriteTransaction,
  schema,
  SHELL_JOB_UNSETTLED_SQL,
  type DatabaseConnection,
  type SqliteValue,
} from "../services/database/index.js";

export type { ShellJobStatus };
export type ShellJobStopReason =
  | "timeout"
  | "user"
  | "model"
  | "owner-ended"
  | "output-limit"
  | "capacity-limit"
  | "internal-error"
  | "rewound"
  | "session-closed"
  | "shutdown";
export type ShellJobCleanup = "in-progress" | "confirmed" | "unconfirmed";
export interface ShellJobRecord {
  readonly jobId: string;
  readonly sessionId: string;
  readonly contextScopeId: string | null;
  readonly rootSessionId: string;
  /** Trusted launch workspace; null for records without a provable workspace. */
  readonly workspaceKey: string | null;
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
  readonly promotedAt: number | null;
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
export interface ShellJobPromotionOptions {
  readonly maxBackgroundJobs: number;
  /** Recheck runtime eligibility and capture the first background checkpoint under the write lock. */
  readonly prepare: () => ShellJobPatch | null;
  /** Apply the runtime transition synchronously after commit. Must not throw or publish events. */
  readonly onCommitted: () => void;
}
export class ShellJobCapacityError extends Error {
  readonly code = "SHELL_JOB_CAPACITY_LIMIT";
  constructor(
    readonly limit: number,
    readonly active: number,
  ) {
    super(
      `Background task capacity reached (${String(active)}/${String(limit)} tasks for this owner). Wait for cleanup to be confirmed or stop an existing task before trying again; do not retry immediately.`,
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
function preparePromotion(
  row: ShellJobRecord,
  options: ShellJobPromotionOptions,
): ShellJobPatch | null {
  if (
    row.mode !== "foreground" ||
    row.status !== "running" ||
    row.stopReason !== null ||
    row.endedAt !== null ||
    row.trackingReleasedAt !== null
  )
    return null;
  const snapshot = options.prepare();
  if (!snapshot) return null;
  const {
    promotedAt,
    outputBytes,
    outputTail,
    outputCheckpointAt,
    outputPath,
    outputTruncated,
    outputComplete,
    noticeState,
  } = snapshot;
  if (promotedAt === undefined || promotedAt === null)
    throw new Error("Shell job promotion requires a timestamp.");
  return definedPatch({
    mode: "background",
    promotedAt,
    outputBytes,
    outputTail,
    outputCheckpointAt,
    outputPath,
    outputTruncated,
    outputComplete,
    noticeState,
  });
}
export interface ShellJobNoticeOwner {
  readonly sessionId: string;
  readonly contextScopeId: string | null;
  /** Required for child delivery: a scope can be reused by a later execution. */
  readonly runId?: string;
}
export interface ShellJobNoticeSelection {
  readonly deliveryGoalId?: string | null;
  readonly includeLost?: boolean;
  /** When present, allocate only main-agent results eligible for this Goal (null means ordinary run). */
  readonly wakeGoalId?: string | null;
}
function matchesNoticeOwner(
  row: ShellJobRecord,
  owner: ShellJobNoticeOwner,
): boolean {
  return (
    row.sessionId === owner.sessionId &&
    row.contextScopeId === owner.contextScopeId &&
    (owner.contextScopeId === null ||
      (owner.runId !== undefined && row.rootRunId === owner.runId))
  );
}
function noticeCandidates(
  rows: readonly ShellJobRecord[],
  owner: ShellJobNoticeOwner,
  options: ShellJobNoticeSelection,
): ShellJobRecord[] {
  const candidates = rows
    .filter(
      (row) =>
        matchesNoticeOwner(row, owner) &&
        row.noticeState === "pending" &&
        row.noticeBatchId === null &&
        row.resultReadyAt !== null &&
        row.status !== null &&
        row.status !== "running" &&
        (options.includeLost !== false || row.status !== "lost") &&
        (options.deliveryGoalId === undefined ||
          row.goalId === null ||
          row.goalId === options.deliveryGoalId) &&
        (options.wakeGoalId === undefined ||
          (row.contextScopeId === null &&
            row.status !== "lost" &&
            row.goalId === options.wakeGoalId &&
            row.noticeWakeRunId === null)),
    )
    .sort(
      (a, b) =>
        (a.resultReadyAt ?? 0) - (b.resultReadyAt ?? 0) ||
        Buffer.compare(Buffer.from(a.jobId), Buffer.from(b.jobId)),
    );
  const first = candidates[0];
  // A frozen batch must remain independently wakeable after a pre-accept crash.
  return candidates
    .slice(0, 20)
    .filter(
      (row) =>
        row.goalId === first.goalId &&
        (row.status === "lost") === (first.status === "lost"),
    );
}
function canClaimNoticeWake(
  rows: readonly ShellJobRecord[],
  goalId: string | null,
): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.contextScopeId === null &&
        row.goalId === goalId &&
        row.status !== "lost" &&
        row.resultReadyAt !== null &&
        row.noticeState === "pending" &&
        row.noticeInputId === null &&
        row.noticeWakeRunId === null,
    )
  );
}
/** Local committed changes only; readers on another backend query the shared database. */
class ShellJobChanges {
  private readonly listeners = new Set<(record: ShellJobRecord) => void>();
  subscribe(listener: (record: ShellJobRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(record: ShellJobRecord): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...record });
      } catch {
        /* Observer failures cannot undo committed facts. */
      }
    }
  }
}
export interface ShellJobStore {
  readonly cleanupNamespace?: string | object;
  query(input: ShellJobQuery): ShellJobPage;
  subscribe(listener: (record: ShellJobRecord) => void): () => void;
  allocateNoticeBatch(
    owner: ShellJobNoticeOwner,
    options?: ShellJobNoticeSelection,
  ): Promise<string | null>;
  getNoticeBatch(batchId: string): readonly ShellJobRecord[];
  /** Only after a deterministic admission rejection and proof this unique run ID never started. */
  releaseUnstartedNoticeWake(
    batchId: string,
    wakeRunId: string,
  ): Promise<boolean>;
  listNoticeBatches(owner: ShellJobNoticeOwner): readonly string[];
  listWakeableNoticeSessions(
    afterSessionId?: string,
    limit?: number,
  ): readonly string[];
  bindNoticeBatch(
    batchId: string,
    expectedInputId: string | null,
    inputId: string,
  ): Promise<boolean>;
  claimNoticeWake(
    batchId: string,
    wakeRunId: string,
    goalId: string | null,
  ): Promise<boolean>;

  insert(
    record: ShellJobRecord,
    options?: ShellJobReservationOptions,
  ): Promise<void>;
  promote(jobId: string, options: ShellJobPromotionOptions): Promise<boolean>;
  update(jobId: string, patch: ShellJobPatch): Promise<void>;
  get(jobId: string): ShellJobRecord | null;
  compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
    beforeWrite?: () => void,
  ): Promise<boolean>;
  listUnsettled(rootSessionId?: string): readonly ShellJobRecord[];
  listByRootRun(rootRunId: string): readonly ShellJobRecord[];
  listByOwner(
    sessionId: string,
    contextScopeId: string | null,
  ): readonly ShellJobRecord[];
}
function requireShellJob(
  store: Pick<ShellJobStore, "get">,
  jobId: string,
): ShellJobRecord {
  const row = store.get(jobId);
  if (!row) throw new Error(`Unknown shell job "${jobId}".`);
  return row;
}
/* eslint-disable @typescript-eslint/require-await -- Atomic synchronous memory transitions implement the asynchronous persistence contract. */
export class InMemoryShellJobStore implements ShellJobStore {
  query(input: ShellJobQuery): ShellJobPage {
    return queryMemoryShellJobs(this.records.values(), input);
  }
  private readonly records = new Map<string, ShellJobRecord>();
  private readonly changes = new ShellJobChanges();
  subscribe(listener: (record: ShellJobRecord) => void): () => void {
    return this.changes.subscribe(listener);
  }
  async allocateNoticeBatch(
    owner: ShellJobNoticeOwner,
    options: ShellJobNoticeSelection = {},
  ): Promise<string | null> {
    const batchId = randomUUID();
    const selected = freezeShellJobNoticeBatch(
      batchId,
      noticeCandidates([...this.records.values()], owner, options),
    );
    if (selected.length === 0) return null;
    for (const item of selected)
      this.records.set(item.jobId, {
        ...requireShellJob(this, item.jobId),
        noticeBatchId: batchId,
        noticePayload: item.payload,
      });
    for (const item of selected)
      this.changes.emit(requireShellJob(this, item.jobId));
    return batchId;
  }
  async releaseUnstartedNoticeWake(
    batchId: string,
    wakeRunId: string,
  ): Promise<boolean> {
    const rows = this.getNoticeBatch(batchId);
    if (
      !rows.length ||
      !rows.every(
        (row) =>
          row.noticeState === "pending" &&
          row.noticeInputId === null &&
          row.noticeWakeRunId === wakeRunId,
      )
    )
      return false;
    for (const row of rows)
      this.records.set(row.jobId, { ...row, noticeWakeRunId: null });
    for (const row of rows)
      this.changes.emit({ ...row, noticeWakeRunId: null });
    return true;
  }
  listWakeableNoticeSessions(
    afterSessionId?: string,
    limit = 100,
  ): readonly string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Notice session limit must be 1..100.");
    return [
      ...new Set(
        [...this.records.values()]
          .filter(
            (row) =>
              row.contextScopeId === null &&
              row.noticeState === "pending" &&
              row.resultReadyAt !== null &&
              row.status !== null &&
              row.status !== "running" &&
              row.status !== "lost" &&
              row.noticeWakeRunId === null,
          )
          .map((row) => row.sessionId),
      ),
    ]
      .filter(
        (id) =>
          afterSessionId === undefined ||
          Buffer.compare(Buffer.from(id), Buffer.from(afterSessionId)) > 0,
      )
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .slice(0, limit);
  }
  listNoticeBatches(owner: ShellJobNoticeOwner): readonly string[] {
    const batches = new Map<string, number>();
    for (const row of this.records.values()) {
      if (
        matchesNoticeOwner(row, owner) &&
        row.noticeBatchId &&
        row.noticeState !== "suppressed"
      )
        batches.set(
          row.noticeBatchId,
          Math.min(
            batches.get(row.noticeBatchId) ?? Infinity,
            row.resultReadyAt ?? 0,
          ),
        );
    }
    return [...batches]
      .sort(
        (a, b) =>
          a[1] - b[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])),
      )
      .map(([id]) => id);
  }
  getNoticeBatch(batchId: string): readonly ShellJobRecord[] {
    return [...this.records.values()]
      .filter((row) => row.noticeBatchId === batchId)
      .sort(
        (a, b) =>
          (a.resultReadyAt ?? 0) - (b.resultReadyAt ?? 0) ||
          Buffer.compare(Buffer.from(a.jobId), Buffer.from(b.jobId)),
      )
      .map((row) => ({ ...row }));
  }
  async bindNoticeBatch(
    batchId: string,
    expectedInputId: string | null,
    inputId: string,
  ): Promise<boolean> {
    const rows = this.getNoticeBatch(batchId);
    if (
      !rows.length ||
      !rows.every(
        (row) =>
          row.noticeInputId === expectedInputId &&
          row.noticeState !== "suppressed",
      )
    )
      return false;
    for (const row of rows)
      this.records.set(row.jobId, {
        ...row,
        noticeState: "accepted",
        noticeInputId: inputId,
      });
    for (const row of rows) this.changes.emit(requireShellJob(this, row.jobId));
    return true;
  }
  async claimNoticeWake(
    batchId: string,
    wakeRunId: string,
    goalId: string | null,
  ): Promise<boolean> {
    const rows = this.getNoticeBatch(batchId);
    if (!canClaimNoticeWake(rows, goalId)) return false;
    for (const row of rows)
      this.records.set(row.jobId, { ...row, noticeWakeRunId: wakeRunId });
    for (const row of rows) this.changes.emit(requireShellJob(this, row.jobId));
    return true;
  }
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
      this.changes.emit(record);
    });
  }
  promote(jobId: string, options: ShellJobPromotionOptions): Promise<boolean> {
    return Promise.resolve().then(() => {
      const row = this.records.get(jobId);
      if (!row) return false;
      const patch = preparePromotion(row, options);
      if (!patch) return false;
      const active = this.listByOwner(row.sessionId, row.contextScopeId).filter(
        holdsBackgroundSlot,
      ).length;
      if (active >= options.maxBackgroundJobs)
        throw new ShellJobCapacityError(options.maxBackgroundJobs, active);
      const saved = { ...row, ...patch };
      this.records.set(jobId, saved);
      options.onCommitted();
      this.changes.emit(saved);
      return true;
    });
  }
  update(jobId: string, patch: ShellJobPatch): Promise<void> {
    const current = this.records.get(jobId);
    if (!current)
      return Promise.reject(new Error(`Unknown shell job "${jobId}".`));
    this.records.set(jobId, { ...current, ...definedPatch(patch) });
    this.changes.emit(requireShellJob(this, jobId));
    return Promise.resolve();
  }
  compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
    beforeWrite?: () => void,
  ): Promise<boolean> {
    beforeWrite?.();
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
    this.changes.emit(requireShellJob(this, jobId));
    return Promise.resolve(true);
  }
  listUnsettled(rootSessionId?: string): readonly ShellJobRecord[] {
    return [...this.records.values()]
      .filter(
        (row) =>
          (rootSessionId === undefined ||
            row.rootSessionId === rootSessionId) &&
          isShellJobUnsettled(row),
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
/* eslint-enable @typescript-eslint/require-await */
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
function findShellJob(
  db: DatabaseConnection,
  jobId: string,
): ShellJobRecord | null {
  const row = db.prepare("SELECT * FROM shell_job WHERE job_id = ?").get(jobId);
  return row ? fromRow(row) : null;
}
function countBackgroundSlots(
  db: DatabaseConnection,
  owner: ShellJobRecord,
): number {
  return (
    db
      .prepare<{
        count: number;
      }>(
        "SELECT count(*) AS count FROM shell_job WHERE session_id = ? AND context_scope_id IS ? AND mode = 'background' AND tracking_released_at IS NULL AND (status IS NULL OR status = 'running' OR cleanup IS NOT 'confirmed')",
      )
      .get(owner.sessionId, owner.contextScopeId)?.count ?? 0
  );
}
function writeShellJobPatch(
  db: DatabaseConnection,
  jobId: string,
  patch: ShellJobPatch,
): ShellJobRecord {
  const changed = Object.keys(patch) as (keyof ShellJobPatch)[];
  const row = db
    .prepare(
      `UPDATE shell_job SET ${changed.map((key) => `${columns[key]} = ?`).join(",")} WHERE job_id = ? RETURNING *`,
    )
    .get(...changed.map((key) => value(patch[key] ?? null)), jobId);
  if (!row) throw new Error(`Unknown shell job "${jobId}".`);
  return fromRow(row);
}
export class DatabaseShellJobStore implements ShellJobStore {
  get cleanupNamespace(): string | object {
    return this.db.path === ":memory:" ? this.db : this.db.path;
  }
  query(input: ShellJobQuery): ShellJobPage {
    return queryDatabaseShellJobs(this.db, input, fromRow);
  }
  private readonly db: DatabaseConnection;
  private readonly changes = new ShellJobChanges();
  subscribe(listener: (record: ShellJobRecord) => void): () => void {
    return this.changes.subscribe(listener);
  }
  async allocateNoticeBatch(
    owner: ShellJobNoticeOwner,
    options: ShellJobNoticeSelection = {},
  ): Promise<string | null> {
    const batchId = randomUUID();
    const changed = await runWriteTransaction(this.db, (tx) => {
      if (owner.contextScopeId !== null && owner.runId === undefined) return [];
      const conditions = [
        "session_id = ?",
        "context_scope_id IS ?",
        "notice_state = 'pending'",
        "notice_batch_id IS NULL",
        "result_ready_at IS NOT NULL",
        "status IS NOT NULL",
        "status != 'running'",
      ];
      const parameters: SqliteValue[] = [owner.sessionId, owner.contextScopeId];
      if (owner.contextScopeId !== null) {
        conditions.push("root_run_id = ?");
        parameters.push(owner.runId ?? null);
      }
      if (options.includeLost === false) conditions.push("status != 'lost'");
      if (options.deliveryGoalId !== undefined) {
        conditions.push("(goal_id IS NULL OR goal_id = ?)");
        parameters.push(options.deliveryGoalId);
      }
      if (options.wakeGoalId !== undefined) {
        conditions.push(
          "context_scope_id IS NULL",
          "status != 'lost'",
          "goal_id IS ?",
          "notice_wake_run_id IS NULL",
        );
        parameters.push(options.wakeGoalId);
      }
      const rows = tx
        .prepare(
          `SELECT * FROM shell_job WHERE ${conditions.join(" AND ")} ORDER BY result_ready_at,job_id LIMIT 20`,
        )
        .all(...parameters)
        .map(fromRow);
      const selected = freezeShellJobNoticeBatch(
        batchId,
        noticeCandidates(rows, owner, options),
      );
      for (const item of selected)
        tx.prepare(
          "UPDATE shell_job SET notice_batch_id = ?, notice_payload = ? WHERE job_id = ?",
        ).run(batchId, item.payload, item.jobId);
      return this.getNoticeBatch(batchId);
    });
    if (changed.length === 0) return null;
    for (const row of changed) this.changes.emit(row);
    return batchId;
  }
  async releaseUnstartedNoticeWake(
    batchId: string,
    wakeRunId: string,
  ): Promise<boolean> {
    const changed = await runWriteTransaction(this.db, (tx) => {
      // Recheck the caller's no-admission proof under the shared writer lock.
      if (
        tx
          .prepare("SELECT run_id FROM run_ledger WHERE run_id = ?")
          .get(wakeRunId)
      )
        return [];
      const rows = this.getNoticeBatch(batchId);
      if (
        !rows.length ||
        !rows.every(
          (row) =>
            row.noticeState === "pending" &&
            row.noticeInputId === null &&
            row.noticeWakeRunId === wakeRunId,
        )
      )
        return [];
      // A foreign run can persist acceptance before its batch-binding CAS.
      if (
        tx
          .prepare(
            "SELECT 1 FROM current_run_input WHERE session_id = ? AND source_id = ? AND source = 'background-task-result' LIMIT 1",
          )
          .get(rows[0].sessionId, `background-task:${batchId}`)
      )
        return [];
      tx.prepare(
        "UPDATE shell_job SET notice_wake_run_id = NULL WHERE notice_batch_id = ?",
      ).run(batchId);
      return this.getNoticeBatch(batchId);
    });
    for (const row of changed) this.changes.emit(row);
    return changed.length > 0;
  }
  listWakeableNoticeSessions(
    afterSessionId?: string,
    limit = 100,
  ): readonly string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Notice session limit must be 1..100.");
    return this.db
      .prepare<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM shell_job WHERE context_scope_id IS NULL AND notice_state = 'pending' AND result_ready_at IS NOT NULL AND status IS NOT NULL AND status NOT IN ('running','lost') AND notice_wake_run_id IS NULL ${afterSessionId === undefined ? "" : "AND session_id > ?"} ORDER BY session_id LIMIT ?`,
      )
      .all(...(afterSessionId === undefined ? [] : [afterSessionId]), limit)
      .map((row) => row.session_id);
  }
  listNoticeBatches(owner: ShellJobNoticeOwner): readonly string[] {
    if (owner.contextScopeId !== null && owner.runId === undefined) return [];
    return this.db
      .prepare<{ batch_id: string }>(
        `
      SELECT j.notice_batch_id AS batch_id FROM shell_job j
      WHERE j.session_id = ? AND j.context_scope_id IS ? AND j.notice_batch_id IS NOT NULL
        AND j.notice_state IN ('pending','accepted')
        ${owner.contextScopeId === null ? "" : "AND j.root_run_id = ?"}
        AND NOT EXISTS (
          SELECT 1 FROM current_run_input i WHERE i.session_id = j.session_id
            AND i.source_id = 'background-task:' || j.notice_batch_id AND i.source = 'background-task-result'
            AND j.notice_state = 'accepted' AND i.input_id = j.notice_input_id
            AND json_extract(i.data,'$.processedRequestId') IS NOT NULL
        )
      GROUP BY j.notice_batch_id ORDER BY min(j.result_ready_at),j.notice_batch_id
    `,
      )
      .all(
        owner.sessionId,
        owner.contextScopeId,
        ...(owner.contextScopeId === null ? [] : [owner.runId ?? null]),
      )
      .map((row) => row.batch_id);
  }
  getNoticeBatch(batchId: string): readonly ShellJobRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM shell_job WHERE notice_batch_id = ? ORDER BY result_ready_at,job_id",
      )
      .all(batchId)
      .map(fromRow);
  }
  async bindNoticeBatch(
    batchId: string,
    expectedInputId: string | null,
    inputId: string,
  ): Promise<boolean> {
    const changed = await runWriteTransaction(this.db, (tx) => {
      const rows = this.getNoticeBatch(batchId);
      if (
        !rows.length ||
        !rows.every(
          (row) =>
            row.noticeInputId === expectedInputId &&
            row.noticeState !== "suppressed",
        )
      )
        return [];
      tx.prepare(
        "UPDATE shell_job SET notice_state = 'accepted', notice_input_id = ? WHERE notice_batch_id = ?",
      ).run(inputId, batchId);
      return this.getNoticeBatch(batchId);
    });
    for (const row of changed) this.changes.emit(row);
    return changed.length > 0;
  }
  async claimNoticeWake(
    batchId: string,
    wakeRunId: string,
    goalId: string | null,
  ): Promise<boolean> {
    const changed = await runWriteTransaction(this.db, (tx) => {
      const rows = this.getNoticeBatch(batchId);
      if (!canClaimNoticeWake(rows, goalId)) return [];
      // Acceptance may win after the caller's preflight and before this writer lock.
      if (
        tx
          .prepare(
            "SELECT 1 FROM current_run_input WHERE session_id = ? AND source_id = ? AND source = 'background-task-result' LIMIT 1",
          )
          .get(rows[0].sessionId, `background-task:${batchId}`)
      )
        return [];
      tx.prepare(
        "UPDATE shell_job SET notice_wake_run_id = ? WHERE notice_batch_id = ?",
      ).run(wakeRunId, batchId);
      return this.getNoticeBatch(batchId);
    });
    for (const row of changed) this.changes.emit(row);
    return changed.length > 0;
  }
  constructor(options: { db?: DatabaseConnection } = {}) {
    this.db = options.db ?? getDatabase();
  }
  async insert(
    record: ShellJobRecord,
    options: ShellJobReservationOptions = {},
  ): Promise<void> {
    const saved = await runWriteTransaction(this.db, (tx) => {
      options.assertAdmitted?.();
      if (
        record.mode === "background" &&
        options.maxBackgroundJobs !== undefined
      ) {
        const active = countBackgroundSlots(tx, record);
        if (active >= options.maxBackgroundJobs)
          throw new ShellJobCapacityError(options.maxBackgroundJobs, active);
      }
      tx.prepare(
        `INSERT INTO shell_job (${keys.map((key) => columns[key]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      ).run(...keys.map((key) => value(record[key])));
      return { ...record };
    });
    this.changes.emit(saved);
  }
  async promote(
    jobId: string,
    options: ShellJobPromotionOptions,
  ): Promise<boolean> {
    const saved = await runWriteTransaction(
      this.db,
      (tx) => {
        const row = findShellJob(tx, jobId);
        if (!row) return null;
        const patch = preparePromotion(row, options);
        if (!patch) return null;
        const active = countBackgroundSlots(tx, row);
        if (active >= options.maxBackgroundJobs)
          throw new ShellJobCapacityError(options.maxBackgroundJobs, active);
        return writeShellJobPatch(tx, jobId, patch);
      },
      (row) => {
        if (row) options.onCommitted();
      },
    );
    if (!saved) return false;
    this.changes.emit(saved);
    return true;
  }
  async update(jobId: string, patch: ShellJobPatch): Promise<void> {
    patch = definedPatch(patch);
    if (Object.keys(patch).length === 0) return;
    const saved = await runWriteTransaction(this.db, (tx) =>
      writeShellJobPatch(tx, jobId, patch),
    );
    this.changes.emit(saved);
  }
  get(jobId: string): ShellJobRecord | null {
    return findShellJob(this.db, jobId);
  }
  async compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
    beforeWrite?: () => void,
  ): Promise<boolean> {
    patch = definedPatch(patch);
    expected = definedPatch(expected);
    const changed = Object.keys(patch) as (keyof ShellJobPatch)[];
    const compared = Object.keys(expected) as (keyof ShellJobPatch)[];
    if (changed.length === 0)
      throw new Error("Shell job CAS requires an update.");
    const changedRow = await runWriteTransaction(this.db, (tx) => {
      beforeWrite?.();
      const result = tx
        .prepare(
          `UPDATE shell_job SET ${changed.map((key) => `${columns[key]} = ?`).join(",")} WHERE job_id = ?${compared.map((key) => ` AND ${columns[key]} IS ?`).join("")}`,
        )
        .run(
          ...changed.map((key) => value(patch[key] ?? null)),
          jobId,
          ...compared.map((key) => value(expected[key] ?? null)),
        );
      return result.changes === 1 ? requireShellJob(this, jobId) : null;
    });
    if (changedRow) this.changes.emit(changedRow);
    return changedRow !== null;
  }
  listUnsettled(rootSessionId?: string): readonly ShellJobRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM shell_job WHERE ${SHELL_JOB_UNSETTLED_SQL}${rootSessionId === undefined ? "" : " AND root_session_id = ?"} ORDER BY created_at,job_id`,
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
