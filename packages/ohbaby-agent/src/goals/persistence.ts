import { SessionRunBusyError } from "../runtime/run-ledger/errors.js";
import { isOwnerProcessAlive, processOwnerId } from "../utils/process-owner.js";
import type { DatabaseConnection } from "../services/database/index.js";
import { schema, runWriteTransaction } from "../services/database/index.js";
import type {
  GoalPersistencePort,
  GoalRecord,
  GoalRecordData,
} from "./types.js";

interface GoalRecordRow {
  readonly session_id: string;
  readonly seq: number;
  readonly created_at: number;
  readonly data: string;
}

/** Check the latest durable goal without starting a driver or normalizing another backend's goal. */
export function readActiveGoalId(
  db: DatabaseConnection,
  sessionId: string,
): string | undefined {
  const row = db
    .prepare<{ id: string; status: string }>(
      `
    WITH current_goal AS (
      SELECT seq, json_extract(data,'$.goalId') AS id FROM goal_record
      WHERE session_id = ? AND json_extract(data,'$.type') = 'create' ORDER BY seq DESC LIMIT 1
    )
    SELECT g.id, COALESCE(json_extract(r.data,'$.status'),'active') AS status
    FROM current_goal g JOIN goal_record r ON r.session_id = ? AND r.seq >= g.seq
      AND json_extract(r.data,'$.goalId') = g.id
    WHERE (r.seq = g.seq OR json_extract(r.data,'$.status') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM goal_record c WHERE c.session_id = r.session_id AND c.seq >= g.seq
        AND json_extract(c.data,'$.goalId') = g.id AND json_extract(c.data,'$.type') = 'clear')
    ORDER BY r.seq DESC LIMIT 1
  `,
    )
    .get(sessionId, sessionId);
  return row?.status === "active" ? row.id : undefined;
}

export function createSqliteGoalPersistence(
  db: DatabaseConnection,
  now: () => number = Date.now,
  ownerId?: string,
): GoalPersistencePort & { releaseOwner(): Promise<void> } {
  const tableName = schema.goalRecord.tableName;
  const activeOwner = (
    sessionId: string,
  ): { goalId: string; local: boolean } | undefined => {
    const row = db
      .prepare<{ goalId: string; id: string; pid: number; processId: string }>(
        `SELECT
      json_extract(value,'$.goalId') AS goalId, json_extract(value,'$.ownerId') AS id,
      json_extract(value,'$.pid') AS pid, json_extract(value,'$.processId') AS processId FROM app_state WHERE scope='goal-driver' AND key=?`,
      )
      .get(sessionId);
    return row &&
      (row.pid === process.pid
        ? row.processId === processOwnerId
        : isOwnerProcessAlive(row.pid))
      ? { goalId: row.goalId, local: row.id === ownerId }
      : undefined;
  };
  return {
    ...(ownerId ? { activeOwner } : {}),
    releaseOwner(): Promise<void> {
      return runWriteTransaction(db, (tx) => {
        tx.prepare(
          "DELETE FROM app_state WHERE scope='goal-driver' AND json_extract(value,'$.ownerId')=?",
        ).run(ownerId ?? null);
      });
    },
    append(sessionId: string, data: GoalRecordData): Promise<void> {
      return runWriteTransaction(db, (tx) => {
        if (ownerId) {
          const owner = activeOwner(sessionId);
          if (owner && !owner.local)
            throw new SessionRunBusyError(sessionId, []);
          if (data.type === "create" || data.status === "active") {
            tx.prepare(
              "INSERT OR REPLACE INTO app_state(scope,key,value,updated_at) VALUES('goal-driver',?,?,?)",
            ).run(
              sessionId,
              JSON.stringify({
                ownerId,
                pid: process.pid,
                processId: processOwnerId,
                goalId: data.goalId,
              }),
              now(),
            );
          } else if (data.type === "clear" || data.status !== undefined) {
            tx.prepare(
              "DELETE FROM app_state WHERE scope='goal-driver' AND key=? AND json_extract(value,'$.goalId')=?",
            ).run(sessionId, data.goalId);
          }
        }
        tx.prepare(
          `INSERT INTO ${tableName} (session_id, seq, created_at, data)
         VALUES (
           ?,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${tableName} WHERE session_id = ?),
           ?,
           ?
         )`,
        ).run(sessionId, sessionId, now(), JSON.stringify(data));
      });
    },
    list(sessionId: string): Promise<readonly GoalRecord[]> {
      const rows = db
        .prepare<GoalRecordRow>(
          `SELECT session_id, seq, created_at, data
           FROM ${tableName} WHERE session_id = ? ORDER BY seq ASC`,
        )
        .all(sessionId);
      return Promise.resolve(
        rows.map((row) => ({
          ...(JSON.parse(row.data) as GoalRecordData),
          createdAt: row.created_at,
          seq: row.seq,
          sessionId: row.session_id,
        })),
      );
    },
  };
}

export class InMemoryGoalPersistence implements GoalPersistencePort {
  private readonly bySession = new Map<string, GoalRecord[]>();

  constructor(private readonly now: () => number = Date.now) {}

  append(sessionId: string, data: GoalRecordData): Promise<void> {
    const records = this.bySession.get(sessionId) ?? [];
    records.push({
      ...data,
      createdAt: this.now(),
      seq: records.length + 1,
      sessionId,
    });
    this.bySession.set(sessionId, records);
    return Promise.resolve();
  }

  list(sessionId: string): Promise<readonly GoalRecord[]> {
    return Promise.resolve([...(this.bySession.get(sessionId) ?? [])]);
  }
}
