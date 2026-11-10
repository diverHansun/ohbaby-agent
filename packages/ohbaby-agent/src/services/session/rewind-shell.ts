import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";
import { isOwnerProcessAlive } from "../../utils/process-owner.js";
import type { DatabaseConnection } from "../database/index.js";

/**
 * Detached shell handles belong to their runtime. A different backend can only
 * prove completion from a saved task_output/task_kill receipt for the same job.
 */
export function assertRewindShellOwners(
  db: DatabaseConnection,
  rootSessionId: string,
  runIds: readonly string[],
  ownerId: string | undefined,
): void {
  if (runIds.length === 0) return;
  const jobs = db
    .prepare<{ run_id: string; owner_pid: number }>(
      `
    WITH roots(id) AS (SELECT value FROM json_each(?)),
    affected(run_id,session_id) AS (
      SELECT id, ? FROM roots
      UNION SELECT child_run_id, child_session_id FROM subagent_execution
        WHERE root_session_id = ? AND root_run_id IN roots AND child_run_id IS NOT NULL
    )
    SELECT DISTINCT r.run_id,r.owner_pid FROM affected a
      JOIN run_ledger r ON r.run_id = a.run_id AND r.session_id = a.session_id
      JOIN message m ON m.session_id = r.session_id AND json_extract(m.data,'$.runId') = r.run_id
      JOIN part p ON p.message_id = m.id AND p.type = 'tool'
    WHERE r.owner_pid IS NOT NULL AND (r.owner_pid <> ? OR r.owner_id IS NOT ?)
      AND json_extract(p.data,'$.tool') = 'bash'
      AND json_extract(p.data,'$.state.input.run_in_background') = 1
      AND json_extract(p.data,'$.state.metadata.jobId') IS NOT NULL
      AND json_extract(p.data,'$.state.metadata.cleanup') IS NOT 'confirmed'
      AND NOT EXISTS (
        SELECT 1 FROM part receipt WHERE receipt.session_id = p.session_id
          AND receipt.type = 'tool'
          AND json_extract(receipt.data,'$.tool') IN ('task_output','task_kill')
          AND json_extract(receipt.data,'$.state.metadata.jobId') = json_extract(p.data,'$.state.metadata.jobId')
          AND json_extract(receipt.data,'$.state.metadata.cleanup') = 'confirmed'
      )
  `,
    )
    .all(
      JSON.stringify(runIds),
      rootSessionId,
      rootSessionId,
      process.pid,
      ownerId ?? null,
    );
  const live = jobs.filter((row) => isOwnerProcessAlive(row.owner_pid));
  if (live.length)
    throw new SessionRunBusyError(
      rootSessionId,
      live.map((row) => row.run_id),
    );
}
