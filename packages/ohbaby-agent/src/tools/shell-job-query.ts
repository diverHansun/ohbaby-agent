import type {
  DatabaseConnection,
  SqliteValue,
} from "../services/database/types.js";
import type { ShellJobRecord } from "./shell-job-store.js";

export const SHELL_JOB_STATUSES = [
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
] as const;
export type ShellJobStatus = (typeof SHELL_JOB_STATUSES)[number];
export type ShellJobQueryScope =
  | { readonly rootSessionId: string }
  | { readonly sessionId: string; readonly contextScopeId: string | null };
export type ShellJobOwnerFilter =
  | { readonly kind: "main" | "subagents" }
  | { readonly kind: "subagent"; readonly subagentId: string };
export interface ShellJobPagePosition {
  readonly attention: number;
  readonly at: number;
  readonly jobId: string;
}
export interface ShellJobQuery {
  readonly scope: ShellJobQueryScope;
  readonly owner?: ShellJobOwnerFilter;
  readonly statuses?: readonly ShellJobStatus[];
  readonly includeFinished?: boolean;
  readonly limit: number;
  readonly before?: ShellJobPagePosition;
}
export interface ShellJobPage {
  readonly rows: readonly ShellJobRecord[];
  readonly hasMore: boolean;
  readonly next?: ShellJobPagePosition;
  readonly pendingStartCount: number;
  readonly filteredCount: number;
  readonly statusCounts: Readonly<Record<ShellJobStatus, number>>;
  readonly unconfirmedCount: number;
}
export class ShellJobQueryError extends Error {
  readonly code = "SHELL_JOB_INVALID_QUERY";
}
/**
 * A record that still carries process, cleanup or final-write responsibility.
 * SHELL_JOB_UNSETTLED_SQL states the same condition for SQL callers.
 */
export function isShellJobUnsettled(row: ShellJobRecord): boolean {
  return (
    row.trackingReleasedAt === null &&
    (row.status === null ||
      row.status === "running" ||
      row.cleanup !== "confirmed" ||
      row.settledAt === null)
  );
}
/** Listed first: a launched job that is still unsettled. */
export function shellJobNeedsAttention(row: ShellJobRecord): boolean {
  return row.status !== null && isShellJobUnsettled(row);
}
export function shellJobPagePosition(
  row: ShellJobRecord,
): ShellJobPagePosition {
  return {
    attention: Number(shellJobNeedsAttention(row)),
    at: row.endedAt ?? row.startedAt ?? row.createdAt,
    jobId: row.jobId,
  };
}
function comparePosition(
  a: ShellJobPagePosition,
  b: ShellJobPagePosition,
): number {
  return (
    b.attention - a.attention ||
    b.at - a.at ||
    Buffer.compare(Buffer.from(b.jobId), Buffer.from(a.jobId))
  );
}
function validateQuery(query: ShellJobQuery): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    throw new ShellJobQueryError(
      "Shell task page limit must be an integer from 1 to 100.",
    );
}
function defaultVisible(row: ShellJobRecord): boolean {
  return (
    row.mode === "background" ||
    row.cleanup === "unconfirmed" ||
    (row.status !== null &&
      row.status !== "running" &&
      (row.cleanup !== "confirmed" || row.settledAt === null))
  );
}
function inScope(row: ShellJobRecord, query: ShellJobQuery): boolean {
  if ("sessionId" in query.scope) {
    if (
      row.sessionId !== query.scope.sessionId ||
      row.contextScopeId !== query.scope.contextScopeId
    )
      return false;
  } else if (row.rootSessionId !== query.scope.rootSessionId) return false;
  if (query.owner?.kind === "main" && row.contextScopeId !== null) return false;
  if (query.owner?.kind === "subagents" && row.contextScopeId === null)
    return false;
  if (
    query.owner?.kind === "subagent" &&
    row.contextScopeId !== query.owner.subagentId
  )
    return false;
  return defaultVisible(row);
}
function filtered(row: ShellJobRecord, query: ShellJobQuery): boolean {
  return (
    row.status !== null &&
    (query.includeFinished !== false || shellJobNeedsAttention(row)) &&
    (!query.statuses?.length || query.statuses.includes(row.status))
  );
}
function statusCounts(): Record<ShellJobStatus, number> {
  return {
    running: 0,
    completed: 0,
    failed: 0,
    timed_out: 0,
    cancelled: 0,
    lost: 0,
  };
}
export function queryMemoryShellJobs(
  records: Iterable<ShellJobRecord>,
  query: ShellJobQuery,
): ShellJobPage {
  validateQuery(query);
  const scoped = [...records].filter((row) => inScope(row, query));
  const counts = statusCounts();
  for (const row of scoped) if (row.status !== null) counts[row.status]++;
  const matching = scoped.filter((row) => filtered(row, query));
  const page = matching
    .filter(
      (row) =>
        !query.before ||
        comparePosition(shellJobPagePosition(row), query.before) > 0,
    )
    .sort((a, b) =>
      comparePosition(shellJobPagePosition(a), shellJobPagePosition(b)),
    )
    .slice(0, query.limit + 1);
  const rows = page.slice(0, query.limit).map((row) => ({ ...row }));
  const hasMore = page.length > query.limit;
  return {
    rows,
    hasMore,
    ...(hasMore ? { next: shellJobPagePosition(rows[rows.length - 1]) } : {}),
    filteredCount: matching.length,
    pendingStartCount: scoped.filter((row) => row.status === null).length,
    statusCounts: counts,
    unconfirmedCount: scoped.filter(
      (row) => row.trackingReleasedAt === null && row.cleanup === "unconfirmed",
    ).length,
  };
}

/** One statement keeps rows and counts on the same SQLite read snapshot. */
export function queryDatabaseShellJobs(
  db: DatabaseConnection,
  query: ShellJobQuery,
  decode: (row: Record<string, unknown>) => ShellJobRecord,
): ShellJobPage {
  validateQuery(query);
  const ownerScope = "sessionId" in query.scope;
  const where = [
    ownerScope
      ? "session_id = ? AND context_scope_id IS ?"
      : "root_session_id = ?",
  ];
  const params: SqliteValue[] =
    "sessionId" in query.scope
      ? [query.scope.sessionId, query.scope.contextScopeId]
      : [query.scope.rootSessionId];
  if (query.owner?.kind === "main") where.push("context_scope_id IS NULL");
  if (query.owner?.kind === "subagents")
    where.push("context_scope_id IS NOT NULL");
  if (query.owner?.kind === "subagent") {
    where.push("context_scope_id = ?");
    params.push(query.owner.subagentId);
  }
  where.push(
    "(mode = 'background' OR cleanup = 'unconfirmed' OR (status IS NOT NULL AND status != 'running' AND (cleanup IS NOT 'confirmed' OR settled_at IS NULL)))",
  );
  const visible = ["status IS NOT NULL"];
  if (query.includeFinished === false) visible.push("_attention = 1");
  if (query.statuses?.length) {
    visible.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
    params.push(...query.statuses);
  }
  let cursor = "";
  if (query.before) {
    cursor =
      "WHERE (_attention < ? OR (_attention = ? AND (_sort_at < ? OR (_sort_at = ? AND job_id < ?))))";
    params.push(
      query.before.attention,
      query.before.attention,
      query.before.at,
      query.before.at,
      query.before.jobId,
    );
  }
  params.push(query.limit + 1);
  const result = db
    .prepare(
      `
    WITH scoped AS (
      SELECT *, CASE WHEN tracking_released_at IS NULL AND (status = 'running' OR (status IS NOT NULL AND (cleanup IS NOT 'confirmed' OR settled_at IS NULL))) THEN 1 ELSE 0 END AS _attention,
        coalesce(ended_at,started_at,created_at) AS _sort_at
      FROM shell_job WHERE ${where.join(" AND ")}
    ), filtered AS (SELECT * FROM scoped WHERE ${visible.join(" AND ")}),
    stats AS (
      SELECT count(CASE WHEN status IS NULL THEN 1 END) AS _pending_count,
        count(CASE WHEN tracking_released_at IS NULL AND cleanup = 'unconfirmed' THEN 1 END) AS _unconfirmed_count,
        ${SHELL_JOB_STATUSES.map((status) => `count(CASE WHEN status = '${status}' THEN 1 END) AS _${status}_count`).join(",")}
      FROM scoped
    ), page AS (SELECT * FROM filtered ${cursor} ORDER BY _attention DESC,_sort_at DESC,job_id DESC LIMIT ?)
    SELECT page.*,stats.*,(SELECT count(*) FROM filtered) AS _filtered_count FROM stats LEFT JOIN page ON 1 = 1
    ORDER BY page._attention DESC,page._sort_at DESC,page.job_id DESC
  `,
    )
    .all(...params);
  const meta = result[0];
  const page = result.filter((row) => row.job_id !== null).map(decode);
  const rows = page.slice(0, query.limit);
  const counts = statusCounts();
  for (const status of SHELL_JOB_STATUSES)
    counts[status] = Number(meta[`_${status}_count`]);
  const hasMore = page.length > query.limit;
  return {
    rows,
    hasMore,
    ...(hasMore ? { next: shellJobPagePosition(rows[rows.length - 1]) } : {}),
    filteredCount: Number(meta._filtered_count),
    pendingStartCount: Number(meta._pending_count),
    statusCounts: counts,
    unconfirmedCount: Number(meta._unconfirmed_count),
  };
}
