import type { UiForkSessionInput } from "ohbaby-sdk";
import { readSessionMessages } from "../../core/message/database-store.js";
import {
  runWriteTransaction,
  type DatabaseConnection,
} from "../../services/database/index.js";
import {
  copySessionHistory,
  findForkableMainRun,
} from "../../services/session/copy-history.js";
import {
  readActiveMainSession,
  readSessionRow,
} from "../../services/session/database-store.js";
import {
  ForkTargetInvalidError,
  HistoryCutInvalidError,
} from "../../services/session/errors.js";
import { resolveSessionDisplayTitle } from "../../services/session/title-fallback.js";
import type { Session } from "../../services/session/types.js";
import { assertSessionInWorkspace } from "../../services/session/working-directory.js";

function nextForkTitle(db: DatabaseConnection, source: Session): string {
  const displayTitle = resolveSessionDisplayTitle({
    title: source.title,
    messages: readSessionMessages(db, source.id, undefined, "user"),
  });
  const base = displayTitle.replace(/ \(\d+\)$/u, "") || "New session";
  // SQLite measures Unicode code points; JavaScript string lengths count UTF-16 units.
  const prefix = base + " (";
  const rows = db
    .prepare<{ title: string }>(
      `SELECT title FROM session WHERE parent_id IS NULL
     AND COALESCE(json_extract(data, '$.isSubagent'), 0) = 0
     AND json_extract(data, '$.sideChat') IS NULL
     AND substr(title, 1, length(?)) = ?`,
    )
    .all(prefix, prefix);
  let max = 0n;
  for (const { title } of rows) {
    const suffix = /^(\d+)\)$/u.exec(title.slice(prefix.length));
    if (!suffix) continue;
    const number = BigInt(suffix[1]);
    if (number > max) max = number;
  }
  return `${base} (${String(max + 1n)})`;
}

export function forkSession(
  db: DatabaseConnection,
  input: UiForkSessionInput,
  promptScopeKey: string,
): Promise<Session> {
  return runWriteTransaction(db, (tx) => {
    const source = readActiveMainSession(tx, input.sessionId);
    assertSessionInWorkspace(source, promptScopeKey);
    const sourceRunId = findForkableMainRun(tx, source.id, input.runId);
    if (sourceRunId === null) throw new ForkTargetInvalidError();

    const title = nextForkTitle(tx, source);
    try {
      const { sessionId } = copySessionHistory(tx, {
        sourceSessionId: source.id,
        cutRunId: sourceRunId,
        promptScopeKey,
        title,
        data: { fork: { sourceSessionId: source.id, sourceRunId } },
      });
      const session = readSessionRow(tx, sessionId);
      if (!session)
        throw new Error(`Fork session was not created: ${sessionId}`);
      return session;
    } catch (error) {
      if (error instanceof HistoryCutInvalidError)
        throw new ForkTargetInvalidError();
      throw error;
    }
  });
}
