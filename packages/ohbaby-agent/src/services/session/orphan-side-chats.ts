import type { DatabaseConnection } from "../database/index.js";
import { deleteSideChatSession } from "./archive.js";
import { cleanupDeletedSessionFiles } from "./archive-files.js";
import { isOwnerProcessAlive } from "../../utils/process-owner.js";

/** Before prompt recovery, discard temporary sessions whose creating process has exited. */
export async function deleteOrphanSideChats(
  db: DatabaseConnection,
  isPidAlive: (pid: number) => boolean = isOwnerProcessAlive,
  cleanup: Parameters<typeof cleanupDeletedSessionFiles>[1] = {
    log: () => undefined,
  },
): Promise<void> {
  const sessions = db
    .prepare<{ id: string; pid: number }>(
      `SELECT id, json_extract(data, '$.sideChat.ownerPid') AS pid
     FROM session WHERE json_extract(data, '$.sideChat') IS NOT NULL`,
    )
    .all();
  for (const { id, pid } of sessions) {
    if (isPidAlive(pid)) continue;
    const deleted = await deleteSideChatSession(db, id, {
      skipBusyCheck: true,
    });
    await cleanupDeletedSessionFiles(deleted, cleanup);
  }
}
