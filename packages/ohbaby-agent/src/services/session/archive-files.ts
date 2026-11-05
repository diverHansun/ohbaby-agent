import path from "node:path";
import { resolveSessionStorageDir } from "../../paths/session-storage.js";
import { rm } from "node:fs/promises";
import { GitSnapshotEngine } from "../../snapshot/diff-engine.js";
import type { DeletedSessionData } from "./archive.js";

/** Runs after the database commits; a failed cleanup never undoes deletion. */
export async function cleanupDeletedSessionFiles(
  result: DeletedSessionData,
  deps: {
    readonly snapshotRoot?: string;
    readonly sessionStorageRoot?: string;
    readonly log: (error: unknown) => void;
  },
): Promise<void> {
  const snapshots = new GitSnapshotEngine({ snapshotRoot: deps.snapshotRoot });
  const report = (error: unknown): void => {
    try {
      deps.log(error);
    } catch {
      /* Diagnostics must not fail deletion. */
    }
  };
  for (const checkpoint of result.checkpoints) {
    try {
      await snapshots.dropRef(checkpoint.checkpointId, checkpoint.workdir);
    } catch (error) {
      report(error);
    }
  }
  for (const id of result.sessionIds) {
    try {
      const directory = resolveSessionStorageDir(id);
      await rm(
        deps.sessionStorageRoot
          ? path.join(deps.sessionStorageRoot, id)
          : directory,
        { recursive: true, force: true },
      );
    } catch (error) {
      report(error);
    }
  }
}
