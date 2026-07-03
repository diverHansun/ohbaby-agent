import type { DatabaseConnection } from "../services/database/index.js";
import { schema } from "../services/database/index.js";
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

export function createSqliteGoalPersistence(
  db: DatabaseConnection,
  now: () => number = Date.now,
): GoalPersistencePort {
  const tableName = schema.goalRecord.tableName;
  return {
    append(sessionId: string, data: GoalRecordData): Promise<void> {
      db.prepare(
        `INSERT INTO ${tableName} (session_id, seq, created_at, data)
         VALUES (
           ?,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${tableName} WHERE session_id = ?),
           ?,
           ?
         )`,
      ).run(sessionId, sessionId, now(), JSON.stringify(data));
      return Promise.resolve();
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
