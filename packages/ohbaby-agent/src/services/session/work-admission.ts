import type { DatabaseConnection } from "../database/types.js";
import { SessionArchiveError } from "./errors.js";

/** The actual durable admission must not follow a concurrent archive commit. */
export function assertActiveSessionForWork(
  db: DatabaseConnection,
  sessionId: string,
): void {
  const archived = db
    .prepare<{ id: string }>(
      `WITH RECURSIVE ancestors(id, parent_id, status) AS (
      SELECT id, parent_id, status FROM session WHERE id = ?
      UNION SELECT s.id, s.parent_id, s.status FROM session s JOIN ancestors a ON s.id = a.parent_id
    ) SELECT id FROM ancestors WHERE status = 'archived' LIMIT 1`,
    )
    .get(sessionId);
  if (archived) throw new SessionArchiveError("SESSION_ARCHIVED", archived.id);
}
