import {
  getDatabase,
  schema,
  type DatabaseConnection,
} from "../database/index.js";

// Shared by matching, snippet extraction and checking an individual anchor.
export const SEARCH_TEXT = `CASE WHEN json_type(p.data, '$.metadata.displayText') = 'text'
  THEN json_extract(p.data, '$.metadata.displayText') ELSE json_extract(p.data, '$.text') END`;

export const SEARCH_EXCLUDED_PART_KINDS: readonly string[] = [
  "context-summary",
  "context-compaction",
  "lifecycle-interruption",
  "system-reminder:v1",
  "model-context:runtime:v1",
];

export const SEARCH_PART = `p.type = 'text' AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
  AND COALESCE(json_extract(p.data, '$.metadata.kind'), '') NOT IN
    (${SEARCH_EXCLUDED_PART_KINDS.map((kind) => `'${kind}'`).join(", ")})`;

export const SEARCH_MESSAGE = `m.rewound_at IS NULL AND m.context_scope_id IS NULL
  AND m.role IN ('user', 'assistant')
  AND (m.agent IS NOT 'context' OR NOT EXISTS (
    SELECT 1 FROM ${schema.part.tableName} summary WHERE summary.message_id = m.id
      AND summary.type = 'text' AND json_extract(summary.data, '$.metadata.kind') = 'context-summary'
  ))
  AND COALESCE(json_extract(m.data, '$.runtimeInput.kind'), 'user-steer') = 'user-steer'`;

// Mirrors listRetriedAttemptIds in the SDK. Only the last owned step request
// can schedule a retry. Its successor can be outside both search hits and the
// anchor window. The session/run lookup uses idx_message_session_run_page.
export const NOT_RETRIED = `NOT (m.role = 'assistant'
  AND (json_type(m.data, '$.error') IS NOT NULL OR json_type(m.data, '$.time.completed') IS NULL)
  AND EXISTS (
    SELECT 1 FROM (
      SELECT value AS request FROM json_each(m.data, '$.modelRequests')
      WHERE value ->> '$.purpose' = 'agent-step'
        AND value ->> '$.messageId' = m.id
        AND value ->> '$.runId' = json_extract(m.data, '$.runId')
      ORDER BY key DESC LIMIT 1
    ) failed
    WHERE failed.request ->> '$.outcome' = 'error'
      AND json_type(failed.request, '$.retryScheduled') = 'true'
      AND EXISTS (
        SELECT 1 FROM ${schema.message.tableName} later, json_each(later.data, '$.modelRequests') next
        WHERE later.session_id = m.session_id
          AND json_extract(later.data, '$.runId') = json_extract(m.data, '$.runId')
          AND later.rewound_at IS NULL AND later.context_scope_id IS NULL
          AND later.role = 'assistant' AND later.id != m.id
          AND next.value ->> '$.purpose' = 'agent-step'
          AND next.value ->> '$.messageId' = later.id
          AND next.value ->> '$.runId' = json_extract(m.data, '$.runId')
          AND next.value ->> '$.step' = failed.request ->> '$.step'
          AND next.value ->> '$.attempt' > failed.request ->> '$.attempt'
          AND next.value ->> '$.startedAt' > 0
      )
  ))`;

export function isSearchableMessage(
  sessionId: string,
  messageId: string,
  db: DatabaseConnection = getDatabase(),
): boolean {
  return db
    .prepare<{ text: string | null }>(
      `SELECT ${SEARCH_TEXT} AS text FROM ${schema.message.tableName} m
     JOIN ${schema.part.tableName} p ON p.message_id = m.id
     WHERE m.id = ? AND m.session_id = ? AND ${SEARCH_MESSAGE} AND ${NOT_RETRIED} AND ${SEARCH_PART}`,
    )
    .all(messageId, sessionId)
    .some(({ text }) => (text ?? "").trim().length > 0);
}
