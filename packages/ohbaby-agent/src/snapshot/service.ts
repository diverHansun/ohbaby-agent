import { randomUUID } from "node:crypto";
import {
  type DiffEngine,
  parsePatchArtifact,
  serializePatchArtifact,
  summaryFromFiles,
} from "./diff-engine.js";
import { SnapshotStore } from "./store.js";
import {
  ArtifactNotAvailableError,
  type ActiveWriterChecker,
  type CaptureSnapshotParams,
  type DiffSnapshotParams,
  type FileDiff,
  type ListCheckpointOptions,
  type MessageCursor,
  type RestoreSnapshotParams,
  type RestoreSnapshotResult,
  type SnapshotCheckpoint,
  SnapshotCheckpointNotFoundError,
  SnapshotConflictError,
  type SnapshotDiff,
  type SnapshotFilePatch,
  type SnapshotPatch,
  type SnapshotPatchArtifact,
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

interface LoadedPatchArtifact {
  readonly patch: SnapshotPatch;
  readonly checkpoint: SnapshotCheckpoint;
  readonly artifact: SnapshotPatchArtifact;
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function createArtifact(
  patch: SnapshotPatch,
  computedFiles: SnapshotPatchArtifact["files"],
): SnapshotPatchArtifact {
  return {
    version: 1,
    checkpointId: patch.checkpointId,
    patchId: patch.patchId,
    createdAt: patch.createdAt,
    files: computedFiles,
  };
}

function patchBeforeContent(file: SnapshotFilePatch): string | undefined {
  if (file.status === "added") {
    return undefined;
  }
  return file.beforeContentBase64;
}

function patchAfterContent(file: SnapshotFilePatch): string | undefined {
  if (file.status === "deleted") {
    return undefined;
  }
  return file.afterContentBase64;
}

function combineNetDiffFiles(
  artifacts: readonly SnapshotPatchArtifact[],
): SnapshotDiff["files"] {
  const filesByPath = new Map<
    string,
    { before: string | undefined; after: string | undefined }
  >();
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      const existing = filesByPath.get(file.path);
      if (existing === undefined) {
        filesByPath.set(file.path, {
          before: patchBeforeContent(file),
          after: patchAfterContent(file),
        });
      } else {
        filesByPath.set(file.path, {
          before: existing.before,
          after: patchAfterContent(file),
        });
      }
    }
  }
  const files: FileDiff[] = [];
  for (const [path, state] of filesByPath) {
    if (state.before === state.after) {
      continue;
    }
    files.push({
      path,
      status:
        state.before === undefined
          ? "added"
          : state.after === undefined
            ? "deleted"
            : "modified",
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
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
    const checkpoint = this.store.createCheckpoint({
      ...params,
      checkpointId: this.createCheckpointId(),
      createdAt: this.now(),
    });
    await this.diffEngine.recordBaseline(
      checkpoint.checkpointId,
      checkpoint.workdir,
    );
    return checkpoint;
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
    const existing = this.store.getPatchByCheckpoint(params.checkpointId);
    if (existing !== undefined) {
      const patch =
        existing.fileCount > 0 && existing.artifactPath === null
          ? await this.persistPatchArtifact(existing, checkpoint)
          : existing;
      if (params.messageCursorAfter !== undefined) {
        this.store.updateCheckpointMessageCursor(
          params.checkpointId,
          params.messageCursorAfter,
        );
      }
      return patch;
    }

    const computed = await this.diffEngine.computeDiff(checkpoint);
    const created = this.store.createPatchIfAbsent({
      patchId: this.createPatchId(),
      checkpointId: checkpoint.checkpointId,
      artifactPath: null,
      fileCount: computed.fileCount,
      createdAt: this.now(),
    });
    let patch = created.patch;
    if (!created.created) {
      patch =
        patch.fileCount > 0 && patch.artifactPath === null
          ? await this.persistPatchArtifact(patch, checkpoint)
          : patch;
      if (params.messageCursorAfter !== undefined) {
        this.store.updateCheckpointMessageCursor(
          checkpoint.checkpointId,
          params.messageCursorAfter,
        );
      }
      return patch;
    }

    if (computed.fileCount > 0) {
      patch = await this.persistPatchArtifact(
        patch,
        checkpoint,
        computed.filePatches,
      );
    }

    this.store.updateCheckpointMessageCursor(
      checkpoint.checkpointId,
      params.messageCursorAfter,
    );
    return patch;
  }

  async diff(params: DiffSnapshotParams): Promise<SnapshotDiff> {
    const fromCheckpoint = this.store.requireCheckpoint(
      params.fromCheckpointId,
    );

    if (params.toCheckpointId === undefined) {
      const computed = await this.diffEngine.computeDiff(fromCheckpoint);
      return {
        fromCheckpointId: params.fromCheckpointId,
        files: computed.files,
        summary: computed.summary,
      };
    }

    const patches = this.store.listPatchesBetweenCheckpoints(
      params.fromCheckpointId,
      params.toCheckpointId,
    );
    const artifacts = await this.loadPatchArtifacts(patches);
    const files = combineNetDiffFiles(artifacts.map((item) => item.artifact));
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

    const patches = this.store.listPatchesFromCheckpoint(
      checkpoint.checkpointId,
    );
    const artifacts = await this.loadPatchArtifacts(patches);
    for (const item of artifacts) {
      await this.diffEngine.applyReverse(
        item.checkpoint.workdir,
        item.artifact,
      );
    }

    return { messageCursorBefore: checkpoint.messageCursorBefore };
  }

  async revert(patches: readonly SnapshotPatch[]): Promise<void> {
    const artifacts = await this.loadPatchArtifacts(patches);
    for (const item of artifacts) {
      await this.diffEngine.applyReverse(
        item.checkpoint.workdir,
        item.artifact,
      );
    }
  }

  private async loadPatchArtifacts(
    patches: readonly SnapshotPatch[],
  ): Promise<LoadedPatchArtifact[]> {
    const artifacts: LoadedPatchArtifact[] = [];
    for (const patch of patches) {
      if (patch.fileCount === 0 && patch.artifactPath === null) {
        continue;
      }
      if (patch.fileCount > 0 && patch.artifactPath === null) {
        throw new ArtifactNotAvailableError(patch.patchId, patch.checkpointId);
      }
      const checkpoint = this.store.requireCheckpoint(patch.checkpointId);
      const artifact = parsePatchArtifact(
        await this.store.readArtifact(patch.patchId),
      );
      artifacts.push({ patch, checkpoint, artifact });
    }
    return artifacts;
  }

  private async persistPatchArtifact(
    patch: SnapshotPatch,
    checkpoint: SnapshotCheckpoint,
    filePatches?: readonly SnapshotFilePatch[],
  ): Promise<SnapshotPatch> {
    const patches =
      filePatches ??
      (await this.diffEngine.computeDiff(checkpoint)).filePatches;
    const artifact = createArtifact(patch, patches);
    try {
      const artifactPath = await this.store.writeArtifact(
        checkpoint.checkpointId,
        patch.patchId,
        serializePatchArtifact(artifact),
      );
      return this.store.updatePatchArtifact(patch.patchId, artifactPath);
    } catch {
      return this.store.requirePatch(patch.patchId);
    }
  }

  listCheckpoints(
    sessionId: string,
    options?: ListCheckpointOptions,
  ): Promise<SnapshotCheckpoint[]> {
    return Promise.resolve(this.store.listCheckpoints(sessionId, options));
  }

  getCheckpoint(checkpointId: string): Promise<SnapshotCheckpoint | undefined> {
    return Promise.resolve(this.store.getCheckpoint(checkpointId));
  }

  getPatches(checkpointId: string): Promise<SnapshotPatch[]> {
    return Promise.resolve(this.store.getPatches(checkpointId));
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
