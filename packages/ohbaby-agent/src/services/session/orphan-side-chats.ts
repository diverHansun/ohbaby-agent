import type { DatabaseConnection } from "../database/index.js";
import { deleteSideChatSession } from "./archive.js";
import { cleanupDeletedSessionFiles } from "./archive-files.js";
import {
  isOwnerProcessAlive,
  processOwnerId,
} from "../../utils/process-owner.js";

/** Before prompt recovery, discard temporary sessions whose creating process has exited. */
export async function deleteOrphanSideChats(
  db: DatabaseConnection,
  isPidAlive: (pid: number) => boolean = isOwnerProcessAlive,
  cleanup: Parameters<typeof cleanupDeletedSessionFiles>[1] = {
    log: () => undefined,
  },
): Promise<void> {
  const sessions = db
    .prepare<{ id: string; pid: number; ownerId: string | null }>(
      `SELECT id, json_extract(data, '$.sideChat.ownerPid') AS pid,
       json_extract(data, '$.sideChat.ownerId') AS ownerId
     FROM session WHERE json_extract(data, '$.sideChat') IS NOT NULL`,
    )
    .all();
  for (const { id, pid, ownerId } of sessions) {
    const previousInstance = pid === process.pid && ownerId !== processOwnerId;
    if (!previousInstance && isPidAlive(pid)) continue;
    const deleted = await deleteSideChatSession(db, id, {
      skipBusyCheck: true,
    });
    await cleanupDeletedSessionFiles(deleted, cleanup);
  }
}
