import {
  getDatabase,
  schema,
  type DatabaseConnection,
} from "../database/index.js";
import {
  readSessionRow,
  rowToSession,
  type SessionRow,
} from "./database-store.js";
import {
  NOT_RETRIED,
  SEARCH_MESSAGE,
  SEARCH_PART,
  SEARCH_TEXT,
} from "./search-visibility.js";
import type { Session } from "./types.js";

/** Cross-project reads of root sessions. Callers own authorization. */

export const GLOBAL_SESSION_PAGE_DEFAULT_LIMIT = 100;
export const GLOBAL_SESSION_PAGE_MAX_LIMIT = 500;

export class InvalidGlobalSessionCursorError extends Error {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("Session cursor is invalid");
    this.name = "InvalidGlobalSessionCursorError";
  }
}

export interface GlobalSessionPageInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: "active" | "archived";
}

/** A listed root session, with when its latest turn that produced a result ended. */
export interface GlobalSession extends Session {
  /** Epoch ms of the latest main turn that succeeded or failed; a stop does not count. */
  readonly lastTurnEndedAt?: number;
}

export interface GlobalSessionPage {
  readonly sessions: readonly GlobalSession[];
  readonly nextCursor?: string;
}

type SearchOrder = "desc" | "asc";

export interface SessionSearchHit {
  readonly session: Session;
  readonly snippet?: string;
  readonly messageId?: string;
}

export interface SessionSearchPage {
  readonly hits: readonly SessionSearchHit[];
  readonly nextCursor?: string;
}

interface Cursor {
  readonly updatedAt: number;
  readonly id: string;
}

const SNIPPET_LIMIT = 120;

export function normalizeGlobalSessionLimit(limit: number | undefined): number {
  if (limit === undefined) return GLOBAL_SESSION_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return Math.min(limit, GLOBAL_SESSION_PAGE_MAX_LIMIT);
}

function encodeCursor(
  cursor: Cursor & ({ group: number } | { order: SearchOrder }),
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(
  value: string | undefined,
  order?: SearchOrder,
): Cursor | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (order === undefined
        ? "group" in parsed && Number.isInteger(parsed.group)
        : "order" in parsed && parsed.order === order) &&
      "updatedAt" in parsed &&
      "id" in parsed &&
      Number.isInteger(parsed.updatedAt) &&
      typeof parsed.id === "string"
    ) {
      return {
        updatedAt: parsed.updatedAt as number,
        id: parsed.id,
      };
    }
  } catch {
    // Fall through to the typed error.
  }
  throw new InvalidGlobalSessionCursorError();
}

export function getGlobalSession(
  sessionId: string,
  db: DatabaseConnection = getDatabase(),
): Session | null {
  return readSessionRow(db, sessionId);
}

/**
 * Hidden projects stay out of the normal list (search still finds them).
 * Matching is by project, not execution directory, so a session moved out
 * of a hidden project's directory stays listed.
 */
const NOT_IN_HIDDEN_WORKSPACE = `(workspace_directory IS NULL OR workspace_directory NOT IN (
  SELECT scope_key FROM ${schema.workspaceRegistry.tableName} WHERE visibility = 'hidden'
))`;

const runLedger = schema.runLedger.columns;

/**
 * Main turns only: subagent turns share the root session but carry a context
 * scope. Correlated with the outer `page` alias, so it runs per listed row.
 */
const LAST_TURN_ENDED_AT = `(SELECT MAX(r.${runLedger.endedAt}) FROM ${schema.runLedger.tableName} r
  WHERE r.${runLedger.sessionId} = page.id
    AND r.${runLedger.contextScopeId} IS NULL
    AND r.${runLedger.status} IN ('succeeded', 'failed'))`;

function rowToGlobalSession(
  row: SessionRow & { readonly last_turn_ended_at: number | null },
): GlobalSession {
  const session = rowToSession(row);
  return typeof row.last_turn_ended_at === "number"
    ? { ...session, lastTurnEndedAt: row.last_turn_ended_at }
    : session;
}

/** Root sessions of the requested status, newest first. */
export function listGlobalSessions(
  input: GlobalSessionPageInput = {},
  db: DatabaseConnection = getDatabase(),
): GlobalSessionPage {
  const limit = normalizeGlobalSessionLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const status = input.status ?? "active";
  const rows = db
    .prepare<SessionRow & { readonly last_turn_ended_at: number | null }>(
      // The page is cut first so the turn end time is read for its rows only.
      `SELECT page.*, ${LAST_TURN_ENDED_AT} AS last_turn_ended_at
       FROM (
         SELECT * FROM ${schema.session.tableName}
         WHERE parent_id IS NULL AND json_extract(data, '$.sideChat') IS NULL AND status = ?
           ${status === "active" ? `AND ${NOT_IN_HIDDEN_WORKSPACE}` : ""}
           AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
         ORDER BY updated_at DESC, id DESC
         LIMIT ?
       ) AS page
       ORDER BY page.updated_at DESC, page.id DESC`,
    )
    .all(
      status,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    );
  const page = rows.slice(0, limit).map(rowToGlobalSession);
  const last = page.at(-1);
  return {
    sessions: page,
    ...(rows.length > limit && last
      ? {
          nextCursor: encodeCursor({
            group: 0,
            updatedAt: last.updatedAt,
            id: last.id,
          }),
        }
      : {}),
  };
}

/** Whitespace separates keywords; empty input means "no search". */
export function splitSearchKeywords(query: string): readonly string[] {
  return query
    .trim()
    .split(/\s+/u)
    .filter((keyword) => keyword !== "");
}

function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}

function allKeywordsLike(column: string, count: number): string {
  return Array.from(
    { length: count },
    () => `${column} LIKE ? ESCAPE '\\'`,
  ).join(" AND ");
}

/** Matches SQLite's ASCII-only case folding used by LIKE. */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

export function buildSearchSnippet(
  text: string,
  keywords: readonly string[],
): string {
  const body = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(body);
  if (chars.length <= SNIPPET_LIMIT) return body;
  const folded = foldAscii(body);
  const matches = keywords
    .map((word) => ({
      offset: folded.indexOf(foldAscii(word)),
      length: Array.from(word).length,
    }))
    .filter(({ offset }) => offset >= 0)
    .sort((a, b) => a.offset - b.offset);

  // Reserve the hits in reading order before spending remaining space on
  // context. Positions and the budget below are in Unicode code points.
  const windows: { start: number; end: number }[] = [];
  let used = 0;
  let offset = 0;
  let pos = 0;
  for (const match of matches) {
    pos += Array.from(body.slice(offset, match.offset)).length;
    offset = match.offset;
    const start = Math.max(0, pos - 15);
    const end = pos + match.length;
    const last = windows.at(-1);
    const overlaps = last !== undefined && last.end >= start;
    const extra = overlaps
      ? Math.max(0, end - last.end)
      : end - start + Number(start > 0);
    if (used + extra + Number(end < chars.length) > SNIPPET_LIMIT) {
      // A single long keyword takes precedence over surrounding context.
      if (!last) {
        const length = Math.min(match.length, SNIPPET_LIMIT);
        const prefix = pos > 0 && length < SNIPPET_LIMIT ? "…" : "";
        const suffix =
          end < chars.length && length + prefix.length < SNIPPET_LIMIT
            ? "…"
            : "";
        return prefix + chars.slice(pos, pos + length).join("") + suffix;
      }
      break;
    }
    if (overlaps) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
    used += extra;
  }
  if (!windows.length) return chars.slice(0, SNIPPET_LIMIT - 1).join("") + "…";

  // Share the remaining context between excerpts. Filling a gap also frees
  // the character reserved for its ellipsis.
  let remaining =
    SNIPPET_LIMIT -
    used -
    Number(windows[windows.length - 1].end < chars.length);
  let snippet = "";
  for (const [i, window] of windows.entries()) {
    const boundary = windows[i + 1]?.start ?? chars.length;
    const extension = Math.min(
      boundary - window.end,
      Math.ceil(remaining / (windows.length - i)),
    );
    if (i === 0 && window.start > 0) snippet += "…";
    const end = window.end + extension;
    snippet += chars.slice(window.start, end).join("");
    if (end < boundary) snippet += "…";
    remaining -= extension;
    if (end === boundary && window.end < boundary) remaining++;
  }
  return snippet;
}

interface SearchRow extends SessionRow {
  readonly hit_message_id: string | null;
  readonly hit_text: string | null;
}

export function searchGlobalSessions(
  input: Pick<GlobalSessionPageInput, "cursor" | "limit"> & {
    readonly query: string;
    readonly order?: SearchOrder;
  },
  db: DatabaseConnection = getDatabase(),
): SessionSearchPage {
  const order = input.order ?? "desc";
  if (!(["asc", "desc"] as const).includes(order))
    throw new RangeError("order must be asc or desc");
  const cursor = decodeCursor(input.cursor, order);
  const keywords = splitSearchKeywords(input.query);
  if (keywords.length === 0) return { hits: [] };
  const limit = normalizeGlobalSessionLimit(input.limit);
  const patterns = keywords.map(likePattern);
  const rows = db
    .prepare<SearchRow>(
      `WITH text_hits AS (
       SELECT p.message_id
       FROM ${schema.part.tableName} p
       WHERE ${SEARCH_PART}
       GROUP BY p.message_id
       HAVING ${keywords.map(() => `MAX(${SEARCH_TEXT} LIKE ? ESCAPE '\\')`).join(" AND ")}
     ), latest_hit AS (
       SELECT m.session_id, m.id,
              ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at DESC, m.id DESC) AS rank
       FROM text_hits h JOIN ${schema.message.tableName} m ON m.id = h.message_id
       WHERE ${SEARCH_MESSAGE} AND ${NOT_RETRIED}
     )
     SELECT s.*, h.id AS hit_message_id, (
       SELECT group_concat(${SEARCH_TEXT}, char(10) ORDER BY
         COALESCE(json_extract(p.data, '$.metadata.sourceOrder'), p.order_index), p.order_index)
       FROM ${schema.part.tableName} p WHERE p.message_id = h.id AND ${SEARCH_PART}
     ) AS hit_text
     FROM ${schema.session.tableName} s
     LEFT JOIN latest_hit h ON h.session_id = s.id AND h.rank = 1
     WHERE s.parent_id IS NULL AND json_extract(s.data, '$.sideChat') IS NULL AND s.status = 'active'
       AND ((${allKeywordsLike("s.title", keywords.length)}) OR h.id IS NOT NULL)
       AND (? IS NULL OR (s.updated_at, s.id) ${order === "asc" ? ">" : "<"} (?, ?))
     ORDER BY s.updated_at ${order}, s.id ${order}
     LIMIT ?`,
    )
    .all(
      ...patterns,
      ...patterns,
      cursor?.id ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    );
  const hits = rows.slice(0, limit).map(
    (row): SessionSearchHit => ({
      session: rowToSession(row),
      ...(row.hit_message_id === null
        ? {}
        : {
            messageId: row.hit_message_id,
            snippet: buildSearchSnippet(row.hit_text ?? "", keywords),
          }),
    }),
  );
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    hits,
    ...(last
      ? {
          nextCursor: encodeCursor({
            order,
            updatedAt: last.updated_at,
            id: last.id,
          }),
        }
      : {}),
  };
}
