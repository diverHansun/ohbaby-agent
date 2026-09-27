import {
  getDatabase,
  runWriteTransaction,
  schema,
  type DatabaseConnection,
  type SqliteValue,
} from "../../services/database/index.js";

export type ExecutionTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "timed_out";
export interface AcceptSubagentExecution {
  readonly executionId: string;
  /** Stable tool call ID or caller supplied request ID within requesterRunId. */
  readonly requestId: string;
  readonly parentSessionId: string;
  readonly requesterScopeId: string;
  readonly requesterRunId: string;
  readonly rootSessionId: string;
  readonly rootRunId: string;
  readonly rootPromptId?: string;
  readonly subagentId: string;
  readonly mode: "foreground" | "background";
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly createdAt: number;
}
export interface ExecutionLookup {
  readonly executionId: string;
  readonly parentSessionId: string;
  readonly requesterScopeId?: string;
}
export interface ExecutionHistory {
  readonly parentSessionId: string;
  readonly requesterScopeId?: string;
  readonly subagentId?: string;
  readonly rootRunId?: string;
  readonly limit?: number;
  readonly before?: {
    readonly createdAt: number;
    readonly executionId: string;
  };
}
export type ExecutionArtifact =
  | { readonly state: "none" | "preparing" }
  | {
      readonly state: "ready";
      readonly path: string;
      readonly sizeBytes: number;
    }
  | { readonly state: "error"; readonly error: string; readonly path?: string };
export interface ExecutionTerminalResult {
  readonly status: ExecutionTerminalStatus;
  readonly reason?: string;
  readonly output?: string;
  readonly error?: string;
  readonly completedAt: number;
}
export interface ExecutionDelivery {
  readonly state: "none" | "foreground" | "pending" | "delivered" | "processed";
  readonly notificationId?: string;
  readonly inputId?: string;
  readonly deliveredAt?: number;
  readonly processedRequestId?: string;
  readonly processedAt?: number;
}
export interface SubagentExecutionRecord extends AcceptSubagentExecution {
  readonly status: "queued" | "running" | ExecutionTerminalStatus;
  readonly childSessionId?: string;
  readonly childScopeId?: string;
  readonly childRunId?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly output?: string;
  readonly error?: string;
  readonly artifact: ExecutionArtifact;
  readonly delivery: ExecutionDelivery;
  /** First late result after interruption; never changes the authoritative terminal. */
  readonly lateResult?: ExecutionTerminalResult;
}
export interface SubagentExecutionStore {
  accept(
    input: AcceptSubagentExecution,
  ): Promise<{ record: SubagentExecutionRecord; created: boolean }>;
  get(input: ExecutionLookup): Promise<SubagentExecutionRecord | null>;
  list(input: ExecutionHistory): Promise<readonly SubagentExecutionRecord[]>;
  listByRootRun(rootRunId: string): Promise<readonly SubagentExecutionRecord[]>;
  bindChild(
    input: ExecutionLookup,
    child: { sessionId: string; contextScopeId: string },
    at: number,
  ): Promise<SubagentExecutionRecord>;
  start(
    input: ExecutionLookup,
    childRunId: string,
    at: number,
  ): Promise<SubagentExecutionRecord>;
  finish(
    input: ExecutionLookup,
    result: ExecutionTerminalResult,
  ): Promise<{ record: SubagentExecutionRecord; claimed: boolean }>;
  updateArtifact(
    input: ExecutionLookup,
    artifact: ExecutionArtifact,
    at: number,
  ): Promise<SubagentExecutionRecord>;
  markDelivered(
    input: ExecutionLookup,
    inputId: string,
    at: number,
  ): Promise<SubagentExecutionRecord>;
  markProcessed(
    input: ExecutionLookup,
    requestId: string,
    at: number,
  ): Promise<SubagentExecutionRecord>;
  interruptRoot(
    rootRunId: string,
    reason: string,
    at: number,
  ): Promise<readonly SubagentExecutionRecord[]>;
}
const terminal = (r: SubagentExecutionRecord): boolean =>
  r.status !== "queued" && r.status !== "running";
function required(value: string): void {
  if (!value.trim()) throw new Error("Execution identity must not be empty");
}
function receiptIdentity(r: AcceptSubagentExecution): string {
  return JSON.stringify([
    r.requestId,
    r.parentSessionId,
    r.requesterScopeId,
    r.requesterRunId,
    r.rootSessionId,
    r.rootRunId,
    r.rootPromptId ?? null,
    r.subagentId,
    r.mode,
    r.prompt,
    r.timeoutMs ?? null,
  ]);
}
function limitFor(input: ExecutionHistory): number {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("History limit must be between 1 and 200");
  return limit;
}
function finishRecord(
  r: SubagentExecutionRecord,
  result: ExecutionTerminalResult,
): SubagentExecutionRecord {
  return {
    ...r,
    ...result,
    updatedAt: result.completedAt,
    delivery:
      r.mode === "foreground"
        ? { state: "foreground" }
        : {
            state: "pending",
            notificationId: `subagent-result:${r.executionId}`,
          },
  };
}
/** Shared transitions run synchronously inside each backend's write transaction. */
abstract class ExecutionStore implements SubagentExecutionStore {
  protected abstract transaction<T>(operation: () => T): Promise<T>;
  protected abstract read(executionId: string): SubagentExecutionRecord | null;
  protected abstract findInvocation(
    requesterRunId: string,
    requestId: string,
  ): SubagentExecutionRecord | null;
  protected abstract save(record: SubagentExecutionRecord): void;
  protected abstract history(
    input: ExecutionHistory,
  ): readonly SubagentExecutionRecord[];
  protected abstract rootRecords(
    rootRunId: string,
  ): readonly SubagentExecutionRecord[];
  private scoped(input: ExecutionLookup): SubagentExecutionRecord | null {
    const r = this.read(input.executionId);
    return r?.parentSessionId === input.parentSessionId &&
      (input.requesterScopeId === undefined ||
        input.requesterScopeId === r.requesterScopeId)
      ? r
      : null;
  }
  async get(input: ExecutionLookup): Promise<SubagentExecutionRecord | null> {
    await Promise.resolve();
    return this.scoped(input);
  }
  async list(
    input: ExecutionHistory,
  ): Promise<readonly SubagentExecutionRecord[]> {
    await Promise.resolve();
    limitFor(input);
    return this.history(input);
  }
  async listByRootRun(
    rootRunId: string,
  ): Promise<readonly SubagentExecutionRecord[]> {
    await Promise.resolve();
    required(rootRunId);
    return this.rootRecords(rootRunId);
  }
  async accept(
    input: AcceptSubagentExecution,
  ): Promise<{ record: SubagentExecutionRecord; created: boolean }> {
    for (const id of [
      input.executionId,
      input.requestId,
      input.parentSessionId,
      input.requesterScopeId,
      input.requesterRunId,
      input.rootSessionId,
      input.rootRunId,
      input.subagentId,
    ])
      required(id);
    if (
      input.timeoutMs !== undefined &&
      (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    )
      throw new Error("Invalid timeout");
    return this.transaction(() => {
      const previous = this.findInvocation(
        input.requesterRunId,
        input.requestId,
      );
      if (previous) {
        if (receiptIdentity(previous) !== receiptIdentity(input))
          throw new Error("Execution acceptance conflict");
        return { record: previous, created: false };
      }
      if (this.read(input.executionId))
        throw new Error("Execution ID conflict");
      const record: SubagentExecutionRecord = {
        ...input,
        status: "queued",
        updatedAt: input.createdAt,
        artifact: { state: "none" },
        delivery: {
          state: input.mode === "foreground" ? "foreground" : "none",
        },
      };
      this.save(record);
      return { record, created: true };
    });
  }
  private mutate(
    input: ExecutionLookup,
    change: (r: SubagentExecutionRecord) => SubagentExecutionRecord,
  ): Promise<SubagentExecutionRecord> {
    return this.transaction(() => {
      const r = this.scoped(input);
      if (!r) throw new Error("Execution not found in requester scope");
      const next = change(r);
      this.save(next);
      return next;
    });
  }
  bindChild(
    input: ExecutionLookup,
    child: { sessionId: string; contextScopeId: string },
    at: number,
  ): Promise<SubagentExecutionRecord> {
    required(child.sessionId);
    required(child.contextScopeId);
    return this.mutate(input, (r) => {
      if (terminal(r)) throw new Error("Cannot bind terminal execution");
      if (r.childSessionId !== undefined) {
        if (
          r.childSessionId !== child.sessionId ||
          r.childScopeId !== child.contextScopeId
        )
          throw new Error("Child identity conflict");
        return r;
      }
      return {
        ...r,
        childSessionId: child.sessionId,
        childScopeId: child.contextScopeId,
        updatedAt: at,
      };
    });
  }
  start(
    input: ExecutionLookup,
    childRunId: string,
    at: number,
  ): Promise<SubagentExecutionRecord> {
    required(childRunId);
    return this.mutate(input, (r) => {
      if (terminal(r)) throw new Error("Cannot start terminal execution");
      if (!r.childSessionId || !r.childScopeId)
        throw new Error("Child must be bound before start");
      if (r.childRunId) {
        if (r.childRunId !== childRunId)
          throw new Error("Child run identity conflict");
        return r;
      }
      return {
        ...r,
        childRunId,
        status: "running",
        startedAt: at,
        updatedAt: at,
      };
    });
  }
  async finish(
    input: ExecutionLookup,
    result: ExecutionTerminalResult,
  ): Promise<{ record: SubagentExecutionRecord; claimed: boolean }> {
    let claimed = false;
    const record = await this.mutate(input, (r) => {
      if (terminal(r))
        return r.status === "interrupted" &&
          result.status !== "interrupted" &&
          !r.lateResult
          ? {
              ...r,
              lateResult: result,
              updatedAt: Math.max(r.updatedAt, result.completedAt),
            }
          : r;
      claimed = true;
      return finishRecord(r, result);
    });
    return { record, claimed };
  }
  updateArtifact(
    input: ExecutionLookup,
    artifact: ExecutionArtifact,
    at: number,
  ): Promise<SubagentExecutionRecord> {
    if (
      artifact.state === "ready" &&
      (!artifact.path ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        artifact.sizeBytes < 0)
    )
      throw new Error("Invalid ready artifact");
    return this.mutate(input, (r) => {
      if (!terminal(r)) throw new Error("Artifact requires terminal result");
      return { ...r, artifact, updatedAt: at };
    });
  }
  markDelivered(
    input: ExecutionLookup,
    inputId: string,
    at: number,
  ): Promise<SubagentExecutionRecord> {
    required(inputId);
    return this.mutate(input, (r) => {
      if (!terminal(r) || r.mode === "foreground")
        throw new Error("No background delivery intent");
      if (r.delivery.inputId) {
        if (r.delivery.inputId !== inputId)
          throw new Error("Delivered input conflict");
        return r;
      }
      return {
        ...r,
        updatedAt: at,
        delivery: {
          ...r.delivery,
          state: "delivered",
          inputId,
          deliveredAt: at,
        },
      };
    });
  }
  markProcessed(
    input: ExecutionLookup,
    requestId: string,
    at: number,
  ): Promise<SubagentExecutionRecord> {
    required(requestId);
    return this.mutate(input, (r) => {
      if (!r.delivery.inputId)
        throw new Error(
          "Delivery must be recorded before processing opportunity",
        );
      if (r.delivery.processedRequestId) {
        if (r.delivery.processedRequestId !== requestId)
          throw new Error("Processed request conflict");
        return r;
      }
      return {
        ...r,
        updatedAt: at,
        delivery: {
          ...r.delivery,
          state: "processed",
          processedRequestId: requestId,
          processedAt: at,
        },
      };
    });
  }
  interruptRoot(
    rootRunId: string,
    reason: string,
    at: number,
  ): Promise<readonly SubagentExecutionRecord[]> {
    required(rootRunId);
    return this.transaction(() =>
      this.rootRecords(rootRunId)
        .filter((r) => !terminal(r))
        .map((r) => {
          const next = finishRecord(r, {
            status: "interrupted",
            reason,
            completedAt: at,
          });
          this.save(next);
          return next;
        }),
    );
  }
}
export class InMemorySubagentExecutionStore extends ExecutionStore {
  private readonly records = new Map<string, SubagentExecutionRecord>();
  protected async transaction<T>(operation: () => T): Promise<T> {
    await Promise.resolve();
    return operation();
  }
  protected read(id: string): SubagentExecutionRecord | null {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }
  protected findInvocation(
    run: string,
    request: string,
  ): SubagentExecutionRecord | null {
    const r = [...this.records.values()].find(
      (r) => r.requesterRunId === run && r.requestId === request,
    );
    return r ? structuredClone(r) : null;
  }
  protected save(r: SubagentExecutionRecord): void {
    this.records.set(r.executionId, structuredClone(r));
  }
  protected history(
    input: ExecutionHistory,
  ): readonly SubagentExecutionRecord[] {
    return [...this.records.values()]
      .filter(
        (r) =>
          r.parentSessionId === input.parentSessionId &&
          (input.requesterScopeId === undefined ||
            r.requesterScopeId === input.requesterScopeId) &&
          (input.subagentId === undefined ||
            r.subagentId === input.subagentId) &&
          (input.rootRunId === undefined || r.rootRunId === input.rootRunId) &&
          (!input.before ||
            r.createdAt < input.before.createdAt ||
            (r.createdAt === input.before.createdAt &&
              r.executionId < input.before.executionId)),
      )
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          (a.executionId < b.executionId
            ? 1
            : a.executionId > b.executionId
              ? -1
              : 0),
      )
      .slice(0, limitFor(input))
      .map((r) => structuredClone(r));
  }
  protected rootRecords(root: string): readonly SubagentExecutionRecord[] {
    return [...this.records.values()]
      .filter((r) => r.rootRunId === root)
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          (a.executionId < b.executionId
            ? -1
            : a.executionId > b.executionId
              ? 1
              : 0),
      )
      .map((r) => structuredClone(r));
  }
}

const columns = schema.subagentExecution.columns;
type Row = Record<string, SqliteValue>;
function toRow(record: SubagentExecutionRecord): Row {
  const row: Row = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = record[key as keyof SubagentExecutionRecord];
    row[column] =
      value === undefined
        ? null
        : typeof value === "object"
          ? JSON.stringify(value)
          : value;
  }
  return row;
}
function fromRow(row: Row): SubagentExecutionRecord {
  const record: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = row[column];
    record[key] =
      value === null
        ? undefined
        : ["artifact", "delivery", "lateResult"].includes(key)
          ? JSON.parse(value as string)
          : value;
  }
  return record as unknown as SubagentExecutionRecord;
}
export class DatabaseSubagentExecutionStore extends ExecutionStore {
  private readonly db: DatabaseConnection;
  constructor(options: { db?: DatabaseConnection } = {}) {
    super();
    this.db = options.db ?? getDatabase();
  }
  protected transaction<T>(operation: () => T): Promise<T> {
    return runWriteTransaction(this.db, operation);
  }
  protected read(id: string): SubagentExecutionRecord | null {
    const row = this.db
      .prepare<Row>(
        `SELECT * FROM ${schema.subagentExecution.tableName} WHERE execution_id = ?`,
      )
      .get(id);
    return row ? fromRow(row) : null;
  }
  protected findInvocation(
    run: string,
    request: string,
  ): SubagentExecutionRecord | null {
    const row = this.db
      .prepare<Row>(
        `SELECT * FROM ${schema.subagentExecution.tableName} WHERE requester_run_id = ? AND request_id = ?`,
      )
      .get(run, request);
    return row ? fromRow(row) : null;
  }
  protected save(record: SubagentExecutionRecord): void {
    const row = toRow(record);
    const names = Object.keys(row);
    this.db
      .prepare(
        `INSERT INTO ${schema.subagentExecution.tableName} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT(execution_id) DO UPDATE SET ${names
          .filter((n) => n !== "execution_id")
          .map((n) => `${n} = excluded.${n}`)
          .join(", ")}`,
      )
      .run(...Object.values(row));
  }
  protected history(
    input: ExecutionHistory,
  ): readonly SubagentExecutionRecord[] {
    const where = ["parent_session_id = ?"];
    const values: SqliteValue[] = [input.parentSessionId];
    for (const [column, value] of [
      ["requester_scope_id", input.requesterScopeId],
      ["subagent_id", input.subagentId],
      ["root_run_id", input.rootRunId],
    ] as const)
      if (value !== undefined) {
        where.push(`${column} = ?`);
        values.push(value);
      }
    if (input.before) {
      where.push("(created_at < ? OR (created_at = ? AND execution_id < ?))");
      values.push(
        input.before.createdAt,
        input.before.createdAt,
        input.before.executionId,
      );
    }
    return this.db
      .prepare<Row>(
        `SELECT * FROM ${schema.subagentExecution.tableName} WHERE ${where.join(" AND ")} ORDER BY created_at DESC, execution_id DESC LIMIT ?`,
      )
      .all(...values, limitFor(input))
      .map(fromRow);
  }
  protected rootRecords(root: string): readonly SubagentExecutionRecord[] {
    return this.db
      .prepare<Row>(
        `SELECT * FROM ${schema.subagentExecution.tableName} WHERE root_run_id = ? ORDER BY created_at ASC, execution_id ASC`,
      )
      .all(root)
      .map(fromRow);
  }
}
