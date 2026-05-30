import { randomUUID } from "node:crypto";
import { type DiffEngine, summaryFromFiles } from "./diff-engine.js";
import { SnapshotStore } from "./store.js";
import {
  type ActiveWriterChecker,
  type CaptureSnapshotParams,
  type DiffSnapshotParams,
  type ListCheckpointOptions,
  type MessageCursor,
  type RestoreSnapshotParams,
  type RestoreSnapshotResult,
  type SnapshotCheckpoint,
  SnapshotCheckpointNotFoundError,
  SnapshotConflictError,
  type SnapshotDiff,
  SnapshotEngineMismatchError,
  SnapshotOperationNotSupportedError,
  type SnapshotPatch,
  type SnapshotRunWorkerHook,
  type SnapshotRunWorkerHookContext,
  type SnapshotRunWorkerHookState,
  type TrackSnapshotParams,
} from "./types.js";

interface SnapshotServiceOptions {
  readonly store: SnapshotStore;
  readonly diffEngine: DiffEngine;
  readonly now?: () => number;
  readonly createCheckpointId?: () => string;
  readonly createPatchId?: () => string;
  readonly activeWriterChecker?: ActiveWriterChecker;
}

interface SnapshotRunWorkerHookOptions {
  readonly service: SnapshotService;
  readonly createTurnId?: (context: SnapshotRunWorkerHookContext) => string;
  readonly resolveWorkdir?: (
    context: SnapshotRunWorkerHookContext,
  ) => string | undefined | Promise<string | undefined>;
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function requireGitCheckpoint(checkpoint: SnapshotCheckpoint): string {
  if (!checkpoint.preTreeRef) {
    throw new SnapshotEngineMismatchError(checkpoint.checkpointId);
  }
  return checkpoint.preTreeRef;
}

export class SnapshotService {
  private readonly now: () => number;
  private readonly createCheckpointId: () => string;
  private readonly createPatchId: () => string;
  private readonly activeWriterChecker?: ActiveWriterChecker;
  private readonly captureLocks = new Map<string, Promise<SnapshotPatch>>();

  constructor(readonly options: SnapshotServiceOptions) {
    this.store = options.store;
    this.diffEngine = options.diffEngine;
    this.now = options.now ?? Date.now;
    this.createCheckpointId =
      options.createCheckpointId ?? ((): string => createId("checkpoint"));
    this.createPatchId =
      options.createPatchId ?? ((): string => createId("patch"));
    this.activeWriterChecker = options.activeWriterChecker;
  }

  readonly store: SnapshotStore;
  private readonly diffEngine: DiffEngine;

  async track(params: TrackSnapshotParams): Promise<SnapshotCheckpoint> {
    const checkpointId = this.createCheckpointId();
    const createdAt = this.now();
    const preTreeRef = await this.diffEngine.recordBaseline(
      checkpointId,
      params.workdir,
    );

    try {
      return this.store.createCheckpoint({
        ...params,
        checkpointId,
        preTreeRef,
        createdAt,
      });
    } catch (error) {
      await this.diffEngine.dropRef(checkpointId, params.workdir).catch(() => {
        // Preserve the metadata write failure as the primary error.
      });
      throw error;
    }
  }

  async capture(params: CaptureSnapshotParams): Promise<SnapshotPatch> {
    const previous = this.captureLocks.get(params.checkpointId);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.captureOnce(params));
    this.captureLocks.set(params.checkpointId, operation);
    try {
      return await operation;
    } finally {
      if (this.captureLocks.get(params.checkpointId) === operation) {
        this.captureLocks.delete(params.checkpointId);
      }
    }
  }

  private async captureOnce(
    params: CaptureSnapshotParams,
  ): Promise<SnapshotPatch> {
    const checkpoint = this.store.requireCheckpoint(params.checkpointId);
    requireGitCheckpoint(checkpoint);

    const existing = this.store.getPatchByCheckpoint(params.checkpointId);
    if (existing !== undefined) {
      this.updateCursorIfProvided(checkpoint.checkpointId, params);
      return existing;
    }

    const computed = await this.diffEngine.computeDiff(checkpoint);
    try {
      const created = this.store.createPatchIfAbsent({
        patchId: this.createPatchId(),
        checkpointId: checkpoint.checkpointId,
        postTreeRef: computed.commit,
        fileCount: computed.fileCount,
        createdAt: this.now(),
      });

      if (!created.created) {
        await this.restoreExistingPostRef(checkpoint, created.patch);
        this.updateCursorIfProvided(checkpoint.checkpointId, params);
        return created.patch;
      }

      this.store.updateCheckpointMessageCursor(
        checkpoint.checkpointId,
        params.messageCursorAfter,
      );
      return created.patch;
    } catch (error) {
      await this.diffEngine
        .dropPostRef(checkpoint.checkpointId, checkpoint.workdir)
        .catch(() => {
          // Preserve the metadata write failure as the primary error.
        });
      throw error;
    }
  }

  async diff(params: DiffSnapshotParams): Promise<SnapshotDiff> {
    if (params.toCheckpointId === undefined) {
      const fromCheckpoint = this.store.requireCheckpoint(
        params.fromCheckpointId,
      );
      requireGitCheckpoint(fromCheckpoint);
      const files = await this.diffEngine.diffWorkingTree(fromCheckpoint);
      return {
        fromCheckpointId: params.fromCheckpointId,
        files,
        summary: summaryFromFiles(files),
      };
    }

    const { from, to } = this.store.assertSameSessionAndWorkdir(
      params.fromCheckpointId,
      params.toCheckpointId,
    );
    const fromRef = requireGitCheckpoint(from);
    const toRef = requireGitCheckpoint(to);
    const files = await this.diffEngine.diffBetween(
      from.workdir,
      fromRef,
      toRef,
    );
    return {
      fromCheckpointId: params.fromCheckpointId,
      toCheckpointId: params.toCheckpointId,
      files,
      summary: summaryFromFiles(files),
    };
  }

  async restore(params: RestoreSnapshotParams): Promise<RestoreSnapshotResult> {
    const checkpoint = this.store.requireCheckpoint(params.checkpointId);
    if (this.activeWriterChecker) {
      const hasActiveWriter = await this.activeWriterChecker({ checkpoint });
      if (hasActiveWriter) {
        throw new SnapshotConflictError(checkpoint.checkpointId);
      }
    }

    await this.diffEngine.restoreTo(
      checkpoint.workdir,
      requireGitCheckpoint(checkpoint),
    );
    return { messageCursorBefore: checkpoint.messageCursorBefore };
  }

  revert(_patches: readonly SnapshotPatch[]): Promise<void> {
    return Promise.reject(new SnapshotOperationNotSupportedError("revert"));
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    const checkpoint = this.store.requireCheckpoint(checkpointId);
    const patches = this.store.getPatches(checkpointId);
    const postTreeRef = patches.find(
      (patch): patch is SnapshotPatch & { readonly postTreeRef: string } =>
        patch.postTreeRef !== null,
    )?.postTreeRef;

    await this.diffEngine.dropRef(checkpointId, checkpoint.workdir);
    try {
      this.store.deleteCheckpoint(checkpointId);
    } catch (error) {
      await this.diffEngine
        .restoreRefs(checkpointId, checkpoint.workdir, {
          ...(checkpoint.preTreeRef === undefined
            ? {}
            : { preTreeRef: checkpoint.preTreeRef }),
          ...(postTreeRef === undefined ? {} : { postTreeRef }),
        })
        .catch(() => {
          // Preserve the metadata delete failure as the primary error.
        });
      throw error;
    }
  }

  async gc(workdir: string, prune?: string): Promise<void> {
    await this.diffEngine.gc(workdir, prune);
  }

  listCheckpoints(
    sessionId: string,
    options?: ListCheckpointOptions,
  ): SnapshotCheckpoint[] {
    return this.store.listCheckpoints(sessionId, options);
  }

  getCheckpoint(checkpointId: string): SnapshotCheckpoint | undefined {
    return this.store.getCheckpoint(checkpointId);
  }

  getPatches(checkpointId: string): SnapshotPatch[] {
    return this.store.getPatches(checkpointId);
  }

  private updateCursorIfProvided(
    checkpointId: string,
    params: CaptureSnapshotParams,
  ): void {
    if (params.messageCursorAfter !== undefined) {
      this.store.updateCheckpointMessageCursor(
        checkpointId,
        params.messageCursorAfter,
      );
    }
  }

  private async restoreExistingPostRef(
    checkpoint: SnapshotCheckpoint,
    patch: SnapshotPatch,
  ): Promise<void> {
    if (patch.postTreeRef === null) {
      await this.diffEngine.dropPostRef(
        checkpoint.checkpointId,
        checkpoint.workdir,
      );
      return;
    }
    await this.diffEngine.restoreRefs(
      checkpoint.checkpointId,
      checkpoint.workdir,
      {
        postTreeRef: patch.postTreeRef,
      },
    );
  }
}

export function createSnapshotRunWorkerHook(
  options: SnapshotRunWorkerHookOptions,
): SnapshotRunWorkerHook {
  return {
    async track(
      context: SnapshotRunWorkerHookContext,
    ): Promise<SnapshotCheckpoint | undefined> {
      const workdir =
        context.workdir ?? (await options.resolveWorkdir?.(context));
      if (workdir === undefined) {
        return undefined;
      }
      return options.service.track({
        sessionId: context.sessionId,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
        turnId:
          context.turnId ??
          options.createTurnId?.(context) ??
          `turn_${context.runId ?? context.sessionId}`,
        workdir,
        ...(context.workspaceSource === undefined
          ? {}
          : { workspaceSource: context.workspaceSource }),
        ...(context.messageCursor === undefined
          ? {}
          : { messageCursorBefore: context.messageCursor }),
      });
    },

    async capture(
      context: SnapshotRunWorkerHookContext,
      state: SnapshotRunWorkerHookState,
    ): Promise<SnapshotPatch | undefined> {
      if (state.checkpointId === undefined) {
        return undefined;
      }
      return options.service.capture({
        checkpointId: state.checkpointId,
        ...(context.messageCursor === undefined
          ? {}
          : { messageCursorAfter: context.messageCursor }),
      });
    },
  };
}

export function requireCheckpoint(
  checkpoint: SnapshotCheckpoint | undefined,
  checkpointId: string,
): SnapshotCheckpoint {
  if (checkpoint === undefined) {
    throw new SnapshotCheckpointNotFoundError(checkpointId);
  }
  return checkpoint;
}

export type { MessageCursor };
