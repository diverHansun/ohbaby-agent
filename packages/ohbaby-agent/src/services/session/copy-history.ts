import { randomUUID } from "node:crypto";
import { createMessageIdGenerator } from "../../core/message/id-generator.js";
import type { DatabaseConnection, SqliteValue } from "../database/types.js";
import type { SessionData, SessionRow } from "./database-store.js";
import { SessionNotFoundError } from "./errors.js";
import { createSessionIdGenerator } from "./id-generator.js";

const terminal = "'succeeded', 'failed', 'cancelled', 'interrupted'";

/** Latest (or specified) ended main turn which actually has a history cut point. */
export function findEndedMainRun(
  db: DatabaseConnection,
  sessionId: string,
  runId?: string,
): string | null {
  return (
    db
      .prepare<{ run_id: string }>(
        `
    WITH anchors AS (
      SELECT json_extract(data, '$.runId') AS run_id,
             MAX(json_extract(data, '$.runtimeInput') IS NULL) AS has_visible_message
      FROM message WHERE session_id = ? AND context_scope_id IS NULL
      GROUP BY json_extract(data, '$.runId')
    ), prompts AS (
      SELECT run_id,
             MAX(status IN ('queued','retained','starting','running')) AS pending,
             MAX(status IN (${terminal})) AS ended
      FROM prompt_submission WHERE session_id = ? AND run_id IS NOT NULL GROUP BY run_id
    )
    SELECT r.run_id FROM run_ledger r
    JOIN anchors ON anchors.run_id = r.run_id
    LEFT JOIN prompts ON prompts.run_id = r.run_id
    WHERE r.session_id = ? AND r.context_scope_id IS NULL
      ${runId === undefined ? "" : "AND r.run_id = ?"}
      AND r.status IN (${terminal}) AND COALESCE(prompts.pending, 0) = 0
      AND (anchors.has_visible_message OR prompts.ended)
    ORDER BY COALESCE(r.started_at, r.created_at) DESC, r.run_id DESC LIMIT 1
  `,
      )
      .get(
        sessionId,
        sessionId,
        sessionId,
        ...(runId === undefined ? [] : [runId]),
      )?.run_id ?? null
  );
}

interface CopyHistoryInput {
  readonly sourceSessionId: string;
  readonly destinationSessionId?: string;
  readonly cutRunId: string | null;
  readonly promptScopeKey: string;
  readonly title: string;
  readonly data?: Partial<SessionData>;
}

type Row = Record<string, SqliteValue>;
type MessageRow = Row & { id: string; data: string; created_at: number };
type PartRow = Row & { id: string; data: string };
type PromptRow = Row & {
  prompt_id: string;
  run_id: string | null;
  user_message_id: string;
  resend_of_prompt_id: string | null;
};
type RunRow = Row & { run_id: string };
type InputRow = Row & { input_id: string; run_id: string };

const createSessionId = createSessionIdGenerator();
const messageIds = createMessageIdGenerator();

interface HistoryRows {
  messages: MessageRow[];
  parts: PartRow[];
  prompts: PromptRow[];
  inputs: InputRow[];
  runs: RunRow[];
}

function selectHistory(
  db: DatabaseConnection,
  input: CopyHistoryInput,
): HistoryRows {
  const { sourceSessionId, cutRunId } = input;
  if (cutRunId === null)
    return { messages: [], parts: [], prompts: [], inputs: [], runs: [] };
  if (!findEndedMainRun(db, sourceSessionId, cutRunId))
    throw new Error(`No ended main turn with messages: ${cutRunId}`);
  const messages = db
    .prepare<MessageRow>(
      `
    SELECT * FROM message WHERE session_id = ? AND context_scope_id IS NULL
    AND (created_at, rowid) <= (
      SELECT created_at, rowid FROM message WHERE session_id = ? AND context_scope_id IS NULL
        AND json_extract(data, '$.runId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    ) ORDER BY created_at, rowid
  `,
    )
    .all(sourceSessionId, sourceSessionId, cutRunId);
  // One bound JSON array also works for histories larger than SQLite's variable limit.
  const messageIds = JSON.stringify(messages.map((m) => m.id));
  const selectedIds = "SELECT value FROM json_each(?)";
  const parts = db
    .prepare<PartRow>(
      `
    SELECT p.* FROM part p JOIN message m ON p.message_id = m.id
    WHERE m.id IN (${selectedIds}) ORDER BY m.created_at, m.rowid, p.order_index
  `,
    )
    .all(messageIds);
  const inputs = db
    .prepare<InputRow>(
      `SELECT * FROM current_run_input WHERE message_id IN (${selectedIds})`,
    )
    .all(messageIds);
  const runIds = new Set(inputs.map((input) => input.run_id));
  for (const message of messages) {
    const { runId } = JSON.parse(message.data) as { runId?: string };
    if (runId) runIds.add(runId);
  }
  const prompts = db
    .prepare<PromptRow>(
      `
    SELECT * FROM prompt_submission WHERE session_id = ? AND scope_key = ?
    AND status IN (${terminal}, 'steered')
    AND (user_message_id IN (${selectedIds}) OR run_id IN (${selectedIds}))
  `,
    )
    .all(
      sourceSessionId,
      input.promptScopeKey,
      messageIds,
      JSON.stringify([...runIds]),
    );
  for (const prompt of prompts) if (prompt.run_id) runIds.add(prompt.run_id);
  const runs = db
    .prepare<RunRow>(
      `
    SELECT * FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL
    AND status IN (${terminal}) AND run_id IN (${selectedIds})
  `,
    )
    .all(sourceSessionId, JSON.stringify([...runIds]));
  return { messages, parts, prompts, inputs, runs };
}

const jsonColumns = new Set([
  "data",
  "steer_receipt",
  "error_data",
  "reasoning_data",
]);

/** Insert in the supplied order. Scalar columns and JSON leaves share the same identity map. */
function insertRows(
  tx: DatabaseConnection,
  table:
    | "message"
    | "part"
    | "run_ledger"
    | "prompt_submission"
    | "current_run_input",
  rows: Row[],
  ids: ReadonlyMap<string, string>,
): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const insert = tx.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (const row of rows) {
    insert.run(
      ...columns.map((column) => {
        const value = row[column];
        if (typeof value !== "string") return value;
        if (!jsonColumns.has(column)) return ids.get(value) ?? value;
        const parsed: unknown = JSON.parse(
          value,
          (_key: string, leaf: unknown) =>
            typeof leaf === "string" ? (ids.get(leaf) ?? leaf) : leaf,
        );
        return JSON.stringify(parsed);
      }),
    );
  }
}

/** Synchronous by design: the caller owns the transaction, including the boundary or fork metadata. */
export function copySessionHistory(
  tx: DatabaseConnection,
  input: CopyHistoryInput,
): { sessionId: string; copiedMessageCount: number } {
  const source = tx
    .prepare<SessionRow>("SELECT * FROM session WHERE id = ?")
    .get(input.sourceSessionId);
  if (!source) throw new SessionNotFoundError(input.sourceSessionId);
  const { reasoning, modelEntryId } = JSON.parse(source.data) as SessionData;
  const { messages, parts, prompts, runs, inputs } = selectHistory(tx, input);
  const sessionId = input.destinationSessionId ?? createSessionId();
  const ids = new Map([[input.sourceSessionId, sessionId]]);
  const now = Date.now();
  const lastMessageAt = messages.at(-1)?.created_at ?? null;
  // SQL view pagination breaks equal-time ties by id. Model history breaks them by
  // rowid instead, so assign ranks separately and insert in the original row order.
  const viewOrder = [...messages].sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
  );
  const width = String(viewOrder.length).length;
  const nonce = randomUUID();
  viewOrder.forEach((m, rank) =>
    ids.set(
      m.id,
      `message_${String(now)}_${String(rank).padStart(width, "0")}_${nonce}`,
    ),
  );
  for (const p of parts) ids.set(p.id, messageIds.partId());
  for (const r of runs) ids.set(r.run_id, `run_${randomUUID()}`);
  for (const i of inputs) ids.set(i.input_id, `input_${randomUUID()}`);
  for (const p of prompts) {
    const newPromptId = `prompt_${randomUUID()}`;
    ids.set(p.prompt_id, newPromptId);
    p.client_request_id = `copy:${newPromptId}`;
    // Failed prompts may still reserve a user-message identity without ever writing the row.
    if (!ids.has(p.user_message_id))
      ids.set(p.user_message_id, `message_${randomUUID()}`);
  }

  tx.prepare(
    `
    INSERT INTO session (id, project_id, working_directory, workspace_directory, pending_working_directory,
      agent, title, status, parent_id, created_at, updated_at, message_count, last_message_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?)
  `,
  ).run(
    sessionId,
    source.project_id,
    source.working_directory,
    source.workspace_directory,
    source.pending_working_directory,
    source.agent,
    input.title,
    now,
    now,
    messages.length,
    lastMessageAt,
    JSON.stringify({
      reasoning,
      modelEntryId,
      childrenIds: [],
      isSubagent: false,
      ...input.data,
    }),
  );

  for (const run of runs) {
    run.owner_id = null;
    run.owner_pid = null;
  }
  for (const prompt of prompts) {
    if (typeof prompt.steer_receipt === "string") {
      const receipt = JSON.parse(prompt.steer_receipt) as Record<
        string,
        unknown
      >;
      prompt.steer_receipt = JSON.stringify({
        ...receipt,
        clientRequestId: `${String(prompt.client_request_id)}:steer`,
      });
    }
    Object.assign(prompt, {
      owner_id: null,
      owner_pid: null,
      edit_lease_id: null,
      edit_lease_owner_id: null,
      edit_lease_expires_at: null,
      title_expected: null,
    });
    if (prompt.resend_of_prompt_id && !ids.has(prompt.resend_of_prompt_id))
      prompt.resend_of_prompt_id = null;
  }
  for (const part of parts) {
    const parsed = JSON.parse(part.data) as { time?: { compacted?: number } };
    if (
      parsed.time?.compacted !== undefined &&
      lastMessageAt !== null &&
      parsed.time.compacted > lastMessageAt
    ) {
      delete parsed.time.compacted;
      part.data = JSON.stringify(parsed);
    }
  }
  insertRows(tx, "message", messages, ids);
  insertRows(tx, "part", parts, ids);
  insertRows(tx, "run_ledger", runs, ids);
  insertRows(tx, "prompt_submission", prompts, ids);
  insertRows(tx, "current_run_input", inputs, ids);
  return { sessionId, copiedMessageCount: messages.length };
}
