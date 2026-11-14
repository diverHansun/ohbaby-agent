import {
  REWIND_BEFORE_COMPACTION_ERROR_CODE,
  REWIND_TARGET_INVALID_ERROR_CODE,
  type UiRewindSessionInput,
} from "ohbaby-sdk";
import { readActiveGoalId } from "../../goals/persistence.js";
import type { GoalService } from "../../goals/index.js";
import type { PromptSubmissionRecord } from "../../runtime/prompt-scheduler/types.js";
import type { WorkspacePromptScheduler } from "../../runtime/prompt-scheduler/scheduler.js";
import type { SessionExecutionGate } from "../session-execution.js";
import type { SessionViewOwner } from "../ui-state/session-view.js";
import type { InProcessRuntimeController } from "./runtime-controller.js";
import { assertRewindShellOwners } from "../../services/session/rewind-shell.js";
import { markRewoundByRootRuns } from "../../agents/subagents/execution-store.js";
import { markMessagesRewound } from "../../core/message/database-store.js";
import {
  listRewindPrompts,
  markPromptsRewound,
} from "../../runtime/prompt-scheduler/database-store.js";
import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";
import {
  runWriteTransaction,
  type DatabaseConnection,
} from "../../services/database/index.js";
import { readActiveMainSession } from "../../services/session/database-store.js";
import { assertSessionInWorkspace } from "../../services/session/working-directory.js";

function invalidTarget(): Error {
  return Object.assign(new Error("Select a visible user message to rewind."), {
    code: REWIND_TARGET_INVALID_ERROR_CODE,
  });
}

interface PeerActivity {
  admission: number;
  last_run: number;
  busy: number;
}

/** An independent TUI cannot share the local admission gate. Keep its work out
 * of this cut even if it starts and finishes while local cleanup is waiting. */
export function captureRewindPeerGuard(
  db: DatabaseConnection,
  sessionId: string,
  backendOwner: string | undefined,
): () => void {
  const activity = db.prepare<PeerActivity>(`
    SELECT p.admission, r.last_run, p.busy OR r.busy AS busy
    FROM (SELECT COALESCE(MAX(admission_order), 0) AS admission,
      COALESCE(MAX(status IN ('queued', 'retained', 'starting', 'running')), 0) AS busy
      FROM prompt_submission WHERE session_id = ? AND owner_id IS NOT ?) p
    CROSS JOIN (SELECT COALESCE(MAX(rowid), 0) AS last_run,
      COALESCE(MAX(status IN ('pending', 'running')), 0) AS busy
      FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL AND owner_id IS NOT ?) r
  `);
  const read = (): PeerActivity => {
    const row = activity.get(
      sessionId,
      backendOwner ?? null,
      sessionId,
      backendOwner ?? null,
    );
    if (!row) throw new SessionRunBusyError(sessionId, []);
    return row;
  };
  const start = read();
  return () => {
    const current = read();
    if (
      start.busy ||
      current.busy ||
      current.admission > start.admission ||
      current.last_run > start.last_run
    )
      throw new SessionRunBusyError(sessionId, []);
  };
}

/** Order by the same (created_at, rowid) pair as the model's main history. */
export function readRewindCut(
  db: DatabaseConnection,
  { sessionId, promptId }: UiRewindSessionInput,
  scopeKey: string,
  requireIdle = false,
): {
  target: PromptSubmissionRecord;
  prompts: PromptSubmissionRecord[];
  runIds: Set<string>;
} {
  const session = readActiveMainSession(db, sessionId);
  assertSessionInWorkspace(session, scopeKey);
  const prompts = listRewindPrompts(db, sessionId, promptId);
  const target = prompts.at(0);
  if (
    !target ||
    !["running", "succeeded", "failed", "interrupted", "cancelled"].includes(
      target.status,
    )
  )
    throw invalidTarget();
  const anchor = db
    .prepare<{ created_at: number; position: number }>(
      `
    SELECT created_at, rowid AS position FROM message
    WHERE id = ? AND session_id = ? AND role = 'user' AND context_scope_id IS NULL
      AND rewound_at IS NULL AND json_extract(data, '$.runtimeInput') IS NULL
  `,
    )
    .get(target.userMessageId, sessionId);
  if (!anchor) throw invalidTarget();
  const bounds = [sessionId, anchor.created_at, anchor.position] as const;
  if (
    db
      .prepare(
        `
    SELECT 1 FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND m.context_scope_id IS NULL AND m.rewound_at IS NULL
      AND (m.created_at, m.rowid) >= (?, ?) AND p.type = 'text'
      AND json_extract(p.data, '$.metadata.kind') = 'context-summary' LIMIT 1
  `,
      )
      .get(...bounds)
  ) {
    throw Object.assign(
      new Error("This message precedes the latest context summary."),
      {
        code: REWIND_BEFORE_COMPACTION_ERROR_CODE,
      },
    );
  }
  if (
    requireIdle &&
    (readActiveGoalId(db, sessionId) !== undefined ||
      db
        .prepare(
          `
    SELECT 1 FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL
      AND status IN ('pending', 'running') LIMIT 1
  `,
        )
        .get(sessionId) ||
      db
        .prepare(
          `
    SELECT 1 FROM prompt_submission WHERE session_id = ? AND rewound_at IS NULL
      AND status IN ('queued', 'starting', 'running', 'retained') LIMIT 1
  `,
        )
        .get(sessionId))
  )
    throw new SessionRunBusyError(sessionId, []);
  const runs = db
    .prepare<{ id: string }>(
      `
    SELECT DISTINCT json_extract(data, '$.runId') AS id FROM message
    WHERE session_id = ? AND context_scope_id IS NULL AND rewound_at IS NULL
      AND (created_at, rowid) >= (?, ?) AND json_extract(data, '$.runId') IS NOT NULL
  `,
    )
    .all(...bounds);
  const runIds = new Set(runs.map((row) => row.id));
  for (const prompt of prompts) if (prompt.runId) runIds.add(prompt.runId);
  return { target, prompts, runIds };
}

export function commitRewind(
  db: DatabaseConnection,
  input: UiRewindSessionInput,
  scopeKey: string,
  stoppedRuns: ReadonlySet<string>,
  admittedPrompts: ReadonlySet<string>,
  backendOwner: string | undefined,
  rewoundAt: string,
  assertNoPeerWork: () => void,
): Promise<{
  messageIds: string[];
  removedPrompts: PromptSubmissionRecord[];
  revision: number;
}> {
  return runWriteTransaction(db, (tx) => {
    assertNoPeerWork();
    const { target, prompts, runIds } = readRewindCut(
      tx,
      input,
      scopeKey,
      true,
    );
    if (
      [...runIds].some((id) => !stoppedRuns.has(id)) ||
      prompts.some((row) => !admittedPrompts.has(row.promptId))
    ) {
      throw new SessionRunBusyError(input.sessionId, []);
    }
    assertRewindShellOwners(tx, input.sessionId, [...runIds], backendOwner);
    const unsettledShell = tx
      .prepare(
        `WITH roots(id) AS (SELECT value FROM json_each(?)),
      affected(id) AS (SELECT id FROM roots UNION SELECT child_run_id FROM subagent_execution
        WHERE root_session_id = ? AND root_run_id IN roots AND child_run_id IS NOT NULL)
      SELECT 1 FROM shell_job WHERE root_session_id = ? AND root_run_id IN affected
        AND tracking_released_at IS NULL AND (status IS NULL OR status = 'running' OR cleanup IS NOT 'confirmed' OR settled_at IS NULL) LIMIT 1`,
      )
      .get(JSON.stringify([...runIds]), input.sessionId, input.sessionId);
    if (unsettledShell) throw new SessionRunBusyError(input.sessionId, []);
    const messageIds = markMessagesRewound(
      tx,
      input.sessionId,
      target.userMessageId,
      rewoundAt,
    );
    const removedPrompts = markPromptsRewound(
      tx,
      input.sessionId,
      prompts.map((prompt) => prompt.promptId),
      rewoundAt,
    );
    markRewoundByRootRuns(tx, input.sessionId, [...runIds], rewoundAt);
    const updated = tx
      .prepare<{
        rewind_revision: number;
      }>(
        "UPDATE session SET rewind_revision = rewind_revision + 1 WHERE id = ? RETURNING rewind_revision",
      )
      .get(input.sessionId);
    if (!updated) throw invalidTarget();
    return { messageIds, removedPrompts, revision: updated.rewind_revision };
  });
}

/** Only individual waits race the deadline. No detached stop loop can acquire a gate after timeout. */
async function withRewindDeadline<T>(
  sessionId: string,
  operation: (
    wait: <V>(step: Promise<V>) => Promise<V>,
    check: () => void,
  ) => Promise<T>,
): Promise<T> {
  const busy = new SessionRunBusyError(sessionId, []);
  // One clock decides expiry. A separate wall-clock check could still pass
  // after the timer fired, letting a late callback reserve the released gate.
  let expired = false;
  const check = (): void => {
    if (expired) throw busy;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(busy);
    }, 10_000);
  });
  try {
    return await operation(
      <V>(step: Promise<V>) => Promise.race([step, timeout]),
      check,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function rewindQueue(
  db: DatabaseConnection,
  sessionId: string,
  backendOwner: string | undefined,
  clientId: string,
  now: number,
): { prompt_id: string; edit_lease_id: string | null }[] {
  const waiting = db
    .prepare<{
      prompt_id: string;
      status: string;
      owner_id: string | null;
      edit_lease_id: string | null;
      edit_lease_owner_id: string | null;
      edit_lease_expires_at: number | null;
    }>(
      `SELECT prompt_id, status, owner_id, edit_lease_id, edit_lease_owner_id, edit_lease_expires_at
      FROM prompt_submission WHERE session_id = ? AND rewound_at IS NULL
      AND status IN ('queued','retained','starting','running') ORDER BY rowid`,
    )
    .all(sessionId);
  if (
    waiting.some(
      (row) =>
        row.status === "retained" ||
        (backendOwner !== undefined && row.owner_id !== backendOwner) ||
        ((row.edit_lease_expires_at ?? 0) > now &&
          row.edit_lease_owner_id !== clientId),
    )
  ) {
    throw new SessionRunBusyError(sessionId, []);
  }
  return waiting.filter((row) => row.status === "queued");
}

export async function stopForRewind({
  sessionId,
  token,
  clientId,
  queue,
  assertReady,
  gate,
  goals,
  scheduler,
  control,
  runtime,
  waitForRun,
  idle,
}: {
  sessionId: string;
  token: symbol;
  clientId: string;
  queue: () => ReturnType<typeof rewindQueue>;
  assertReady: () => void;
  gate: SessionExecutionGate;
  goals: GoalService;
  scheduler: WorkspacePromptScheduler;
  control: SessionViewOwner;
  runtime: InProcessRuntimeController;
  waitForRun: () => Promise<string | undefined>;
  idle: () => boolean;
}): Promise<void> {
  const busy = (): SessionRunBusyError =>
    new SessionRunBusyError(sessionId, []);
  await withRewindDeadline(sessionId, async (wait, check) => {
    const goal = await wait(goals.getSnapshot(sessionId));
    assertReady();
    queue();
    if (goal?.status === "active") {
      check();
      await wait(
        goals.pauseGoal(sessionId, "Editing a message", {
          preserveBackground: true,
        }),
      );
    }
    for (;;) {
      assertReady();
      check();
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = gate.subscribe(sessionId, wake);
      try {
        for (const pending of queue()) {
          check();
          await wait(
            scheduler.cancelQueued(
              pending.prompt_id,
              pending.edit_lease_id ?? undefined,
              clientId,
            ),
          ).catch((error: unknown) => {
            const code =
              error instanceof Error && "code" in error
                ? error.code
                : undefined;
            if (code === "PROMPT_NOT_QUEUED") return;
            if (
              code === "PROMPT_EDIT_LEASE_HELD" ||
              code === "PROMPT_EDIT_LEASE_LOST"
            )
              throw busy();
            throw error;
          });
        }
        const runId = await wait(waitForRun());
        if (runId) {
          check();
          if (await wait(runtime.abortPromptRun(runId))) {
            const activeRuntime = await wait(runtime.getRuntime());
            await wait(activeRuntime.runManager.waitForCompletion(runId));
          }
        }
        const reserved = await wait(
          control.runControl(sessionId, () => {
            check();
            assertReady();
            return Promise.resolve(
              idle() &&
                !queue().length &&
                goals.peekSnapshot(sessionId)?.status !== "active" &&
                gate.reserve(sessionId, token),
            );
          }),
        );
        if (reserved) break;
        await wait(changed);
      } finally {
        unsubscribe();
      }
    }
  });
}

/** Legacy snapshots include terminal runs without messages. Only suppress runs whose anchors were rewound. */
export function fullyRewoundRuns(
  db: DatabaseConnection,
  sessionIds: readonly string[],
): Set<string> {
  const rows = db
    .prepare<{ id: string }>(
      `
    WITH visible_sessions(id) AS (SELECT id FROM session WHERE rewind_revision > 0 AND id IN (SELECT value FROM json_each(?))),
    anchors(id, rewound_at) AS (
      SELECT json_extract(data, '$.runId'), rewound_at FROM message
        WHERE session_id IN visible_sessions AND context_scope_id IS NULL
      UNION ALL SELECT run_id, rewound_at FROM prompt_submission WHERE session_id IN visible_sessions
    )
    SELECT id FROM anchors WHERE id IS NOT NULL GROUP BY id HAVING count(*) = count(rewound_at)
  `,
    )
    .all(JSON.stringify(sessionIds));
  return new Set(rows.map((row) => row.id));
}
