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

export interface GlobalSessionPage {
  readonly sessions: readonly Session[];
  readonly nextCursor?: string;
}

export type SessionSearchMatchType = "title" | "message";

export interface SessionSearchHit {
  readonly session: Session;
  readonly matchType: SessionSearchMatchType;
  readonly snippet: string;
  readonly messageId?: string;
}

export interface SessionSearchPage {
  readonly hits: readonly SessionSearchHit[];
  readonly nextCursor?: string;
}

interface Cursor {
  readonly group: number;
  readonly updatedAt: number;
  readonly id: string;
}

const SNIPPET_RADIUS = 60;

export function normalizeGlobalSessionLimit(limit: number | undefined): number {
  if (limit === undefined) return GLOBAL_SESSION_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return Math.min(limit, GLOBAL_SESSION_PAGE_MAX_LIMIT);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "group" in parsed &&
      "updatedAt" in parsed &&
      "id" in parsed &&
      Number.isInteger(parsed.group) &&
      Number.isInteger(parsed.updatedAt) &&
      typeof parsed.id === "string"
    ) {
      return {
        group: parsed.group as number,
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

/** Runtime inputs (subagent notices, etc.) render as system text; only steering is user-visible. */
const VISIBLE_MESSAGE = `(json_extract(m.data, '$.runtimeInput.kind') IS NULL
  OR json_extract(m.data, '$.runtimeInput.kind') = 'user-steer')`;

/** Root sessions of the requested status, newest first. */
export function listGlobalSessions(
  input: GlobalSessionPageInput = {},
  db: DatabaseConnection = getDatabase(),
): GlobalSessionPage {
  const limit = normalizeGlobalSessionLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const status = input.status ?? "active";
  const rows = db
    .prepare<SessionRow>(
      `SELECT * FROM ${schema.session.tableName}
       WHERE parent_id IS NULL AND status = ?
         ${status === "active" ? `AND ${NOT_IN_HIDDEN_WORKSPACE}` : ""}
         AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      status,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    );
  const page = rows.slice(0, limit).map(rowToSession);
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

function messageText(db: DatabaseConnection, messageId: string): string {
  return db
    .prepare<{ readonly text: string | null }>(
      `SELECT json_extract(data, '$.text') AS text
       FROM ${schema.part.tableName}
       WHERE message_id = ? AND type = 'text'
         AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0
       ORDER BY order_index ASC`,
    )
    .all(messageId)
    .map((row) => row.text ?? "")
    .join("\n");
}

/** Matches SQLite's ASCII-only case folding used by LIKE. */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

export function buildSearchSnippet(
  text: string,
  keywords: readonly string[],
): string {
  const folded = foldAscii(text);
  const positions = keywords
    .map((keyword) => folded.indexOf(foldAscii(keyword)))
    .filter((index) => index >= 0);
  const first = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, first - SNIPPET_RADIUS);
  const end = Math.min(text.length, first + SNIPPET_RADIUS * 2);
  const body = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

interface SearchRow extends SessionRow {
  readonly match_group: number;
  readonly hit_message_id: string | null;
}

/**
 * Searches titles and visible user/assistant text of every active root
 * session. A hit needs every keyword inside one title or one message;
 * title hits sort first, then each group by update time.
 */
export function searchGlobalSessions(
  input: GlobalSessionPageInput & { readonly query: string },
  db: DatabaseConnection = getDatabase(),
): SessionSearchPage {
  const keywords = splitSearchKeywords(input.query);
  if (keywords.length === 0) return { hits: [] };
  const limit = normalizeGlobalSessionLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const patterns = keywords.map(likePattern);
  const partText = `COALESCE(json_extract(p.data, '$.text'), '')`;
  const titleMatch = allKeywordsLike("s.title", keywords.length);
  const rows = db
    .prepare<SearchRow>(
      `WITH hit_messages AS (
         SELECT m.session_id AS session_id, p.message_id AS message_id,
                MAX(m.created_at) AS created_at
         FROM ${schema.part.tableName} p
         JOIN ${schema.message.tableName} m ON m.id = p.message_id
         WHERE p.type = 'text'
           AND m.role IN ('user', 'assistant')
           AND m.context_scope_id IS NULL
           AND ${VISIBLE_MESSAGE}
           AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
         GROUP BY p.message_id
         HAVING ${keywords
           .map(() => `SUM(${partText} LIKE ? ESCAPE '\\') > 0`)
           .join(" AND ")}
       ),
       latest_hit AS (
         SELECT session_id, message_id FROM (
           SELECT session_id, message_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY created_at DESC, message_id DESC
                  ) AS rank
           FROM hit_messages
         ) WHERE rank = 1
       ),
       candidates AS (
         SELECT s.*,
                CASE WHEN ${titleMatch} THEN 0 ELSE 1 END AS match_group,
                h.message_id AS hit_message_id
         FROM ${schema.session.tableName} s
         LEFT JOIN latest_hit h ON h.session_id = s.id
         WHERE s.parent_id IS NULL AND s.status = 'active'
           AND ((${titleMatch}) OR h.session_id IS NOT NULL)
       )
       SELECT * FROM candidates
       WHERE ? IS NULL
          OR match_group > ?
          OR (match_group = ? AND (updated_at < ?
              OR (updated_at = ? AND id < ?)))
       ORDER BY match_group ASC, updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      ...patterns,
      ...patterns,
      ...patterns,
      cursor?.group ?? null,
      cursor?.group ?? null,
      cursor?.group ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    );
  const hits = rows.slice(0, limit).map((row): SessionSearchHit => {
    const session = rowToSession(row);
    if (row.match_group === 0 || row.hit_message_id === null) {
      return {
        session,
        matchType: "title",
        snippet: buildSearchSnippet(session.title, keywords),
      };
    }
    return {
      session,
      matchType: "message",
      messageId: row.hit_message_id,
      snippet: buildSearchSnippet(
        messageText(db, row.hit_message_id),
        keywords,
      ),
    };
  });
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    hits,
    ...(last
      ? {
          nextCursor: encodeCursor({
            group: last.match_group,
            updatedAt: last.updated_at,
            id: last.id,
          }),
        }
      : {}),
  };
}
