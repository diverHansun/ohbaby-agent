import { fingerprint } from "./agent-loop-assembly.js";
/** Read-only SQLite evidence. Never serialize the in-memory visible body. */
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { hash } from "./agent-loop-observer.js";

export function savedFailure(
  sessionId: string,
  errorName?: string,
): {
  text: string;
  errors: string[];
  nativeCount: number;
  textHashes: string[];
  textPartIds: string[];
  factPartIds: string[];
  factCount: number;
} {
  const rows = getDatabase()
    .prepare<{
      id: string;
      text: string | null;
      type: string;
      error: string | null;
      synthetic: number | null;
      ignored: number | null;
      kind: string | null;
    }>(
      `SELECT p.id, json_extract(p.data, '$.text') AS text, p.type,
      json_extract(m.data, '$.error.name') AS error,
      json_extract(p.data, '$.synthetic') AS synthetic,
      json_extract(p.data, '$.ignored') AS ignored,
      json_extract(p.data, '$.metadata.kind') AS kind
     FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ? AND m.context_scope_id IS NULL AND m.role = 'assistant'
       AND json_extract(m.data, '$.error') IS NOT NULL
       AND (? IS NULL OR json_extract(m.data, '$.error.name') = ?)
       AND json_extract(p.data, '$.time.compacted') IS NULL
     ORDER BY p.created_at, p.order_index`,
    )
    .all(sessionId, errorName ?? null, errorName ?? null);
  const visible = rows.filter(
    (row) =>
      row.type === "text" &&
      row.text &&
      !row.synthetic &&
      !row.ignored &&
      row.kind !== "lifecycle-interruption",
  );
  const facts = rows.filter(
    (row) =>
      row.type === "text" &&
      row.synthetic === 1 &&
      row.kind === "lifecycle-interruption",
  );
  return {
    text: visible.map((row) => row.text ?? "").join(""),
    errors: [...new Set(rows.map((row) => row.error ?? "unknown"))],
    nativeCount: rows.filter((row) => row.type === "model-state").length,
    textHashes: visible.map((row) => hash(row.text ?? "")),
    textPartIds: visible.map((row) => row.id),
    factPartIds: facts.map((row) => row.id),
    factCount: facts.length,
  };
}

export interface CarrierEvidence {
  id: string;
  messageId: string;
  retired: boolean;
  kind: string | null;
}
export function interruptionCarriers(sessionId: string): CarrierEvidence[] {
  return getDatabase()
    .prepare<{
      id: string;
      messageId: string;
      retired: number;
      kind: string | null;
    }>(
      `SELECT p.id, p.message_id AS messageId, json_extract(p.data, '$.time.compacted') IS NOT NULL AS retired,
      json_extract(p.data, '$.metadata.kind') AS kind
     FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ? AND m.context_scope_id IS NULL AND m.role = 'assistant' AND p.type = 'text'
       AND (json_extract(m.data, '$.error') IS NOT NULL OR json_extract(p.data, '$.metadata.kind') = 'lifecycle-interruption')
     ORDER BY p.id`,
    )
    .all(sessionId)
    .map((row) => ({ ...row, retired: row.retired === 1 }));
}

export function persistedToolProof(
  sessionId: string,
  callId: string,
):
  | {
      callId: string;
      partId: string;
      messageId: string;
      status: string;
      acceptedFinish: string | null;
      assistantError: string | null;
      inputHash: string;
      nativeCount: number;
      outputHash: string;
      outputCharacters: number;
    }
  | undefined {
  const row = getDatabase()
    .prepare<{
      partId: string;
      messageId: string;
      status: string;
      acceptedFinish: string | null;
      assistantError: string | null;
      output: string | null;
      input: string;
      nativeCount: number;
    }>(
      `SELECT p.id AS partId, p.message_id AS messageId, json_extract(p.data, '$.state.input') AS input, (SELECT COUNT(*) FROM part n WHERE n.message_id=m.id AND n.type='model-state') AS nativeCount, json_extract(p.data, '$.state.status') AS status,
      json_extract(p.data, '$.state.output') AS output, json_extract(m.data, '$.finish') AS acceptedFinish,
      json_extract(m.data, '$.error.name') AS assistantError
     FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ? AND p.type = 'tool' AND json_extract(p.data, '$.callId') = ?`,
    )
    .get(sessionId, callId);
  if (!row) return undefined;
  const { output, input, ...safe } = row;
  return {
    ...safe,
    callId,
    inputHash: fingerprint(JSON.parse(input)),
    outputHash: hash(output ?? ""),
    outputCharacters: output?.length ?? 0,
  };
}
