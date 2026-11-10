import { randomUUID } from "node:crypto";
import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";
import {
  isOwnerProcessAlive,
  processOwnerId,
} from "../../utils/process-owner.js";
import {
  runWriteTransaction,
  type DatabaseConnection,
} from "../database/index.js";

// A failed DELETE can outlive its operation while the backend process stays alive.
const liveOperations = new Set<string>();

/** Manual compaction and rewind edit the same history across independent runtimes. */
export async function acquireSessionHistoryOperation(
  db: DatabaseConnection,
  sessionId: string,
): Promise<() => Promise<void>> {
  const operationId = randomUUID();
  const owner = JSON.stringify({
    pid: process.pid,
    processId: processOwnerId,
    operationId,
  });
  liveOperations.add(operationId);
  try {
    await runWriteTransaction(db, (tx) => {
      const row = tx
        .prepare<{
          pid: number;
          processId: string;
          operationId: string;
        }>(
          `SELECT json_extract(value, '$.pid') AS pid, json_extract(value, '$.processId') AS processId,
              json_extract(value, '$.operationId') AS operationId
           FROM app_state WHERE scope = 'session-history-operation' AND key = ?`,
        )
        .get(sessionId);
      if (
        row &&
        (row.pid === process.pid
          ? row.processId === processOwnerId &&
            liveOperations.has(row.operationId)
          : isOwnerProcessAlive(row.pid))
      ) {
        throw new SessionRunBusyError(sessionId, []);
      }
      tx.prepare(
        "INSERT OR REPLACE INTO app_state (scope,key,value,updated_at) VALUES ('session-history-operation',?,?,?)",
      ).run(sessionId, owner, Date.now());
    });
  } catch (error) {
    liveOperations.delete(operationId);
    throw error;
  }
  return async () => {
    try {
      await runWriteTransaction(db, (tx) => {
        const result = tx
          .prepare(
            "DELETE FROM app_state WHERE scope='session-history-operation' AND key=? AND value=?",
          )
          .run(sessionId, owner);
        if (result.changes !== 1)
          throw new Error("Session history operation lost its ownership");
      });
    } finally {
      liveOperations.delete(operationId);
    }
  };
}
