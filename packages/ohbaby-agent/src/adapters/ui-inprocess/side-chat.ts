import { processOwnerId } from "../../utils/process-owner.js";
import { randomUUID } from "node:crypto";
import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";
import {
  PromptNotQueuedError,
  PromptEditLeaseHeldError,
  PromptEditLeaseLostError,
} from "../../runtime/prompt-scheduler/errors.js";
import type { UiBackendClient } from "ohbaby-sdk";
import {
  insertMessageRow,
  insertPartRow,
} from "../../core/message/database-store.js";
import { createMessage, createPart } from "../../core/message/factory.js";
import { createMessageIdGenerator } from "../../core/message/id-generator.js";
import type { TriggerSource } from "../../runtime/run-ledger/types.js";
import {
  runWriteTransaction,
  type DatabaseConnection,
} from "../../services/database/index.js";
import { SessionArchiveError } from "../../services/session/archive.js";
import {
  copySessionHistory,
  findEndedMainRun,
} from "../../services/session/copy-history.js";
import {
  readActiveMainSession,
  readSessionRow,
} from "../../services/session/database-store.js";
import { assertSessionInWorkspace } from "../../services/session/working-directory.js";
import { SideChatUnsupportedError } from "../../services/session/errors.js";
import type {
  Session,
  SideChatMetadata,
} from "../../services/session/types.js";

export const SIDE_CHAT_ID_PREFIX = "session_side_";

const boundary = [
  "You are now in a side chat. The preceding conversation was copied from the main session for reference.",
  "Do not continue tasks from the main conversation. Do not change files, Git, or configuration unless the user explicitly asks after this boundary.",
  "Subagents are not available in side chat.",
].join("\n");

interface SideChatRow {
  ownerId: string | null;
  sideChatId: string;
  title: string;
  createdAt: number;
  boundaryMessageId: string;
  workingDirectory: string;
}

export function sideChatsForMain(
  db: DatabaseConnection,
  mainSessionId: string,
  ownerId?: string,
): SideChatRow[] {
  return db
    .prepare<SideChatRow>(
      `SELECT id AS sideChatId, title, created_at AS createdAt,
            COALESCE(pending_working_directory, working_directory) AS workingDirectory,
            json_extract(data, '$.sideChat.ownerId') AS ownerId,
            json_extract(data, '$.sideChat.boundaryMessageId') AS boundaryMessageId
     FROM session WHERE json_extract(data, '$.sideChat.mainSessionId') = ?
       AND (? IS NULL OR json_extract(data, '$.sideChat.ownerId') = ?)
     ORDER BY created_at, rowid`,
    )
    .all(mainSessionId, ownerId ?? null, ownerId ?? null);
}

export function listSideChats(
  db: DatabaseConnection,
  mainSessionId: string,
): Awaited<ReturnType<UiBackendClient["listSideChats"]>> {
  readActiveMainSession(db, mainSessionId);
  return {
    sideChats: sideChatsForMain(db, mainSessionId, processOwnerId).map(
      (row) => ({
        sideChatId: row.sideChatId,
        title: row.title,
        boundaryMessageId: row.boundaryMessageId,
        workingDirectory: row.workingDirectory,
        createdAt: new Date(row.createdAt).toISOString(),
      }),
    ),
  };
}

function nextTitle(db: DatabaseConnection, mainId: string): string {
  const titles = new Set(sideChatsForMain(db, mainId).map((row) => row.title));
  let n = 1;
  while (titles.has(`Side chat ${String(n)}`)) n++;
  return `Side chat ${String(n)}`;
}

function boundaryText(
  db: DatabaseConnection,
  mainId: string,
  hasCut: boolean,
): string {
  const run = db
    .prepare<{ run_id: string; trigger: TriggerSource }>(
      `SELECT run_id, trigger FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL
     AND status IN ('pending','running') ORDER BY COALESCE(started_at, created_at) DESC, run_id DESC LIMIT 1`,
    )
    .get(mainId);
  if (run?.trigger === "background-task")
    return (
      boundary + "\nThe main session is processing a background task result."
    );
  if (run?.trigger === "subagent")
    return (
      boundary + "\nThe main session is processing a result from a subagent."
    );
  if (run?.trigger === "goal") {
    const goal = db
      .prepare<{ objective: string }>(
        `SELECT json_extract(data, '$.objective') AS objective FROM goal_record WHERE session_id = ?
       AND json_extract(data, '$.objective') IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      )
      .get(mainId);
    return (
      boundary +
      "\nThe main session is continuing its goal." +
      (goal ? "\n" + goal.objective : "")
    );
  }
  if (!run && hasCut) return boundary;
  const prompt = db
    .prepare<{ text: string }>(
      `SELECT text FROM prompt_submission WHERE session_id = ?
     AND ((? IS NOT NULL AND run_id = ?) OR (run_id IS NULL AND status IN ('starting', 'queued')))
     ORDER BY (run_id IS NOT NULL) DESC, (status = 'starting') DESC, admission_order LIMIT 1`,
    )
    .get(mainId, run?.run_id ?? null, run?.run_id ?? null);
  return prompt
    ? boundary +
        "\nThe current user request in the main session is:\n" +
        prompt.text
    : boundary;
}

/** The history, boundary, stats and title all belong to the same source snapshot. */
export function openSideChat(
  db: DatabaseConnection,
  mainId: string,
  promptScopeKey: string,
  now: () => number,
): Promise<Session & { sideChat: SideChatMetadata }> {
  return runWriteTransaction(db, (tx) => {
    const main = readActiveMainSession(tx, mainId);
    assertSessionInWorkspace(main, promptScopeKey);
    const cutRunId = findEndedMainRun(tx, mainId);
    if (
      !cutRunId &&
      !tx
        .prepare(
          `SELECT 1 FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL
       UNION ALL SELECT 1 FROM prompt_submission WHERE session_id = ? LIMIT 1`,
        )
        .get(mainId, mainId)
    )
      throw new SideChatUnsupportedError("Send a message first");
    const ids = createMessageIdGenerator();
    // On equal timestamps, "-copy" < "-side" < the digits/hex of a live message ID.
    const boundaryMessageId = `message_-side_${randomUUID()}`;
    const { sessionId } = copySessionHistory(tx, {
      sourceSessionId: mainId,
      destinationSessionId: SIDE_CHAT_ID_PREFIX + randomUUID(),
      cutRunId,
      promptScopeKey,
      title: nextTitle(tx, mainId),
      data: {
        sideChat: {
          mainSessionId: mainId,
          boundaryMessageId,
          ownerId: processOwnerId,
          ownerPid: process.pid,
        },
      },
    });
    // Future-dated history would hide subsequent prompts behind this boundary.
    const last = readSessionRow(tx, sessionId)?.stats.lastMessageAt ?? -1;
    const at = now();
    if (last > at)
      throw new SideChatUnsupportedError(
        `History is dated in the future. Retry after ${new Date(last).toISOString()}.`,
      );
    const message = createMessage({
      data: {
        id: boundaryMessageId,
        role: "user",
        agent: main.agentName,
        sessionId,
      },
      idGenerator: ids,
      now: () => at,
    });
    const part = createPart({
      message,
      idGenerator: ids,
      orderIndex: 0,
      data: { type: "text", text: boundaryText(tx, mainId, cutRunId !== null) },
    });
    insertMessageRow(tx, message);
    insertPartRow(tx, part, at);
    tx.prepare(
      "UPDATE session SET message_count = message_count + 1, last_message_at = ?, updated_at = ? WHERE id = ?",
    ).run(at, at, sessionId);
    const created = readSessionRow(tx, sessionId);
    if (!created?.sideChat)
      throw new SessionArchiveError("SESSION_NOT_FOUND", sessionId);
    return { ...created, sideChat: created.sideChat };
  });
}

/** A run may start between the queued prompt read and cancellation. Re-read until quiescent. */
export async function stopSideChatWork(
  db: DatabaseConnection,
  sessionId: string,
  controls: {
    cancel: (promptId: string, leaseId?: string) => Promise<unknown>;
    abort: (runId: string) => Promise<boolean>;
    hasLocalWork: () => boolean;
  },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SessionRunBusyError(sessionId, []));
    }, 5000);
  });
  const withinDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, timeout]);
  try {
    const aborted = new Set<string>();
    for (;;) {
      const prompts = db
        .prepare<{
          prompt_id: string;
          edit_lease_id: string | null;
          status: string;
        }>(
          "SELECT prompt_id, edit_lease_id, status FROM prompt_submission WHERE session_id = ? AND status IN ('queued','starting','running')",
        )
        .all(sessionId);
      for (const prompt of prompts) {
        if (prompt.status === "running") continue;
        try {
          await withinDeadline(
            controls.cancel(
              prompt.prompt_id,
              prompt.edit_lease_id ?? undefined,
            ),
          );
        } catch (error) {
          if (
            !(
              error instanceof PromptNotQueuedError ||
              error instanceof PromptEditLeaseLostError ||
              error instanceof PromptEditLeaseHeldError
            )
          )
            throw error;
        }
      }
      const runs = db
        .prepare<{
          run_id: string;
        }>(
          "SELECT run_id FROM run_ledger WHERE session_id = ? AND status IN ('pending','running')",
        )
        .all(sessionId);
      for (const { run_id: id } of runs) {
        if (!aborted.has(id) && (await withinDeadline(controls.abort(id))))
          aborted.add(id);
      }
      if (!runs.length && !prompts.length && !controls.hasLocalWork()) return;
      await withinDeadline(
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
