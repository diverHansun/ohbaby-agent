import type {
  DatabaseConnection,
  SqliteValue,
} from "../services/database/index.js";
import { schema } from "../services/database/index.js";
import {
  type CreateCheckpointInput,
  type CreatePatchInput,
  type ListCheckpointOptions,
  type MessageCursor,
  type SnapshotCheckpoint,
  SnapshotCheckpointNotFoundError,
  SnapshotError,
  type SnapshotPatch,
  SnapshotPatchNotFoundError,
  type WorkspaceSource,
} from "./types.js";

interface SnapshotStoreOptions {
  readonly db: DatabaseConnection;
}

interface CreatePatchIfAbsentResult {
  readonly patch: SnapshotPatch;
  readonly created: boolean;
}

interface CheckpointRow {
  readonly checkpoint_id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly turn_id: string;
  readonly workdir: string;
  readonly workspace_source: string | null;
  readonly message_cursor_before: string | null;
  readonly message_cursor_after: string | null;
  readonly pre_tree_ref: string | null;
  readonly created_at: number;
}

interface PatchRow {
  readonly patch_id: string;
  readonly checkpoint_id: string;
  readonly post_tree_ref: string | null;
  readonly file_count: number;
  readonly created_at: number;
}

function encodeCursor(cursor: MessageCursor | undefined): string | null {
  return cursor === undefined ? null : JSON.stringify(cursor);
}

function decodeCursor(value: string | null): MessageCursor | undefined {
  return value === null ? undefined : (JSON.parse(value) as MessageCursor);
}

function rowToCheckpoint(row: CheckpointRow): SnapshotCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    turnId: row.turn_id,
    workdir: row.workdir,
    ...(row.workspace_source === null
      ? {}
      : { workspaceSource: row.workspace_source as WorkspaceSource }),
    ...(row.message_cursor_before === null
      ? {}
      : { messageCursorBefore: decodeCursor(row.message_cursor_before) }),
    ...(row.message_cursor_after === null
      ? {}
      : { messageCursorAfter: decodeCursor(row.message_cursor_after) }),
    ...(row.pre_tree_ref === null ? {} : { preTreeRef: row.pre_tree_ref }),
    createdAt: row.created_at,
  };
}

function rowToPatch(row: PatchRow): SnapshotPatch {
  return {
    patchId: row.patch_id,
    checkpointId: row.checkpoint_id,
    postTreeRef: row.post_tree_ref,
    fileCount: row.file_count,
    createdAt: row.created_at,
  };
}

const CHECKPOINT_COLUMNS = `checkpoint_id, session_id, run_id, turn_id, workdir,
  workspace_source, message_cursor_before, message_cursor_after, pre_tree_ref,
  created_at`;

const PATCH_COLUMNS = `patch_id, checkpoint_id, post_tree_ref, file_count,
  created_at`;

export class SnapshotStore {
  constructor(private readonly options: SnapshotStoreOptions) {}

  createCheckpoint(input: CreateCheckpointInput): SnapshotCheckpoint {
    this.options.db
      .prepare(
        `INSERT INTO ${schema.snapshotCheckpoint.tableName}
          (checkpoint_id, session_id, run_id, turn_id, workdir, workspace_source,
           message_cursor_before, message_cursor_after, pre_tree_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.checkpointId,
        input.sessionId,
        input.runId ?? null,
        input.turnId,
        input.workdir,
        input.workspaceSource ?? null,
        encodeCursor(input.messageCursorBefore),
        null,
        input.preTreeRef,
        input.createdAt,
      );

    return {
      checkpointId: input.checkpointId,
      sessionId: input.sessionId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      turnId: input.turnId,
      workdir: input.workdir,
      ...(input.workspaceSource === undefined
        ? {}
        : { workspaceSource: input.workspaceSource }),
      ...(input.messageCursorBefore === undefined
        ? {}
        : { messageCursorBefore: input.messageCursorBefore }),
      preTreeRef: input.preTreeRef,
      createdAt: input.createdAt,
    };
  }

  updateCheckpointMessageCursor(
    checkpointId: string,
    messageCursorAfter: MessageCursor | undefined,
  ): SnapshotCheckpoint {
    this.options.db
      .prepare(
        `UPDATE ${schema.snapshotCheckpoint.tableName}
         SET message_cursor_after = ?
         WHERE checkpoint_id = ?`,
      )
      .run(encodeCursor(messageCursorAfter), checkpointId);
    return this.requireCheckpoint(checkpointId);
  }

  getCheckpoint(checkpointId: string): SnapshotCheckpoint | undefined {
    const row = this.options.db
      .prepare<CheckpointRow>(
        `SELECT ${CHECKPOINT_COLUMNS}
         FROM ${schema.snapshotCheckpoint.tableName}
         WHERE checkpoint_id = ?`,
      )
      .get(checkpointId);
    return row === undefined ? undefined : rowToCheckpoint(row);
  }

  requireCheckpoint(checkpointId: string): SnapshotCheckpoint {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (checkpoint === undefined) {
      throw new SnapshotCheckpointNotFoundError(checkpointId);
    }
    return checkpoint;
  }

  deleteCheckpoint(checkpointId: string): void {
    this.options.db
      .prepare(
        `DELETE FROM ${schema.snapshotCheckpoint.tableName}
         WHERE checkpoint_id = ?`,
      )
      .run(checkpointId);
  }

  listCheckpoints(
    sessionId: string,
    options: ListCheckpointOptions = {},
  ): SnapshotCheckpoint[] {
    const params: SqliteValue[] = [sessionId];
    const conditions = ["session_id = ?"];
    if (options.runId !== undefined) {
      conditions.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.turnId !== undefined) {
      conditions.push("turn_id = ?");
      params.push(options.turnId);
    }

    const rows = this.options.db
      .prepare<CheckpointRow>(
        `SELECT ${CHECKPOINT_COLUMNS}
         FROM ${schema.snapshotCheckpoint.tableName}
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, checkpoint_id DESC`,
      )
      .all(...params);
    return rows.map(rowToCheckpoint);
  }

  createPatch(input: CreatePatchInput): SnapshotPatch {
    this.options.db
      .prepare(
        `INSERT INTO ${schema.snapshotPatch.tableName}
          (patch_id, checkpoint_id, post_tree_ref, file_count, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.patchId,
        input.checkpointId,
        input.postTreeRef,
        input.fileCount,
        input.createdAt,
      );
    return {
      patchId: input.patchId,
      checkpointId: input.checkpointId,
      postTreeRef: input.postTreeRef,
      fileCount: input.fileCount,
      createdAt: input.createdAt,
    };
  }

  createPatchIfAbsent(input: CreatePatchInput): CreatePatchIfAbsentResult {
    this.options.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getPatchByCheckpoint(input.checkpointId);
      if (existing !== undefined) {
        this.options.db.exec("COMMIT");
        return { patch: existing, created: false };
      }
      const patch = this.createPatch(input);
      this.options.db.exec("COMMIT");
      return { patch, created: true };
    } catch (error) {
      try {
        this.options.db.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }

  getPatch(patchId: string): SnapshotPatch | undefined {
    const row = this.options.db
      .prepare<PatchRow>(
        `SELECT ${PATCH_COLUMNS}
         FROM ${schema.snapshotPatch.tableName}
         WHERE patch_id = ?`,
      )
      .get(patchId);
    return row === undefined ? undefined : rowToPatch(row);
  }

  requirePatch(patchId: string): SnapshotPatch {
    const patch = this.getPatch(patchId);
    if (patch === undefined) {
      throw new SnapshotPatchNotFoundError(patchId);
    }
    return patch;
  }

  getPatchByCheckpoint(checkpointId: string): SnapshotPatch | undefined {
    const row = this.options.db
      .prepare<PatchRow>(
        `SELECT ${PATCH_COLUMNS}
         FROM ${schema.snapshotPatch.tableName}
         WHERE checkpoint_id = ?
         ORDER BY created_at ASC, patch_id ASC
         LIMIT 1`,
      )
      .get(checkpointId);
    return row === undefined ? undefined : rowToPatch(row);
  }

  getPatches(checkpointId: string): SnapshotPatch[] {
    const rows = this.options.db
      .prepare<PatchRow>(
        `SELECT ${PATCH_COLUMNS}
         FROM ${schema.snapshotPatch.tableName}
         WHERE checkpoint_id = ?
         ORDER BY created_at ASC, patch_id ASC`,
      )
      .all(checkpointId);
    return rows.map(rowToPatch);
  }

  listPatchesFromCheckpoint(checkpointId: string): SnapshotPatch[] {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const rows = this.options.db
      .prepare<PatchRow>(
        `SELECT patch.patch_id, patch.checkpoint_id, patch.post_tree_ref,
                patch.file_count, patch.created_at
         FROM ${schema.snapshotPatch.tableName} patch
         INNER JOIN ${schema.snapshotCheckpoint.tableName} checkpoint
           ON checkpoint.checkpoint_id = patch.checkpoint_id
         WHERE checkpoint.session_id = ?
           AND checkpoint.workdir = ?
           AND checkpoint.created_at >= ?
         ORDER BY patch.created_at DESC, patch.patch_id DESC`,
      )
      .all(checkpoint.sessionId, checkpoint.workdir, checkpoint.createdAt);
    return rows.map(rowToPatch);
  }

  listPatchesBetweenCheckpoints(
    fromCheckpointId: string,
    toCheckpointId: string,
  ): SnapshotPatch[] {
    const fromCheckpoint = this.requireCheckpoint(fromCheckpointId);
    const toCheckpoint = this.requireCheckpoint(toCheckpointId);
    if (
      fromCheckpoint.sessionId !== toCheckpoint.sessionId ||
      fromCheckpoint.workdir !== toCheckpoint.workdir
    ) {
      throw new SnapshotError(
        "Cannot diff checkpoints from different sessions or workdirs",
      );
    }
    const rows = this.options.db
      .prepare<PatchRow>(
        `SELECT patch.patch_id, patch.checkpoint_id, patch.post_tree_ref,
                patch.file_count, patch.created_at
         FROM ${schema.snapshotPatch.tableName} patch
         INNER JOIN ${schema.snapshotCheckpoint.tableName} checkpoint
           ON checkpoint.checkpoint_id = patch.checkpoint_id
         WHERE checkpoint.session_id = ?
           AND checkpoint.workdir = ?
           AND checkpoint.created_at >= ?
           AND checkpoint.created_at < ?
         ORDER BY patch.created_at ASC, patch.patch_id ASC`,
      )
      .all(
        fromCheckpoint.sessionId,
        fromCheckpoint.workdir,
        fromCheckpoint.createdAt,
        toCheckpoint.createdAt,
      );
    return rows.map(rowToPatch);
  }

  assertSameSessionAndWorkdir(
    fromCheckpointId: string,
    toCheckpointId: string,
  ): { readonly from: SnapshotCheckpoint; readonly to: SnapshotCheckpoint } {
    const from = this.requireCheckpoint(fromCheckpointId);
    const to = this.requireCheckpoint(toCheckpointId);
    if (from.sessionId !== to.sessionId || from.workdir !== to.workdir) {
      throw new SnapshotError(
        "Cannot diff checkpoints from different sessions or workdirs",
      );
    }
    return { from, to };
  }
}
