export type WorkspaceSource = "sandbox" | "session" | "project";

export interface MessageCursor {
  readonly messageId?: string;
  readonly partId?: string;
  readonly sequence: number;
}

export interface SnapshotCheckpoint {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly workdir: string;
  readonly workspaceSource?: WorkspaceSource;
  readonly messageCursorBefore?: MessageCursor;
  readonly messageCursorAfter?: MessageCursor;
  readonly createdAt: number;
}

export interface SnapshotPatch {
  readonly patchId: string;
  readonly checkpointId: string;
  readonly artifactPath: string | null;
  readonly fileCount: number;
  readonly createdAt: number;
}

export type FileDiffStatus = "added" | "modified" | "deleted";

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export interface FileDiff {
  readonly path: string;
  readonly status: FileDiffStatus;
  readonly hunks?: readonly DiffHunk[];
}

export interface SnapshotDiffSummary {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

export interface SnapshotDiff {
  readonly fromCheckpointId: string;
  readonly toCheckpointId?: string;
  readonly files: readonly FileDiff[];
  readonly summary: SnapshotDiffSummary;
}

export interface SnapshotFilePatch {
  readonly path: string;
  readonly status: FileDiffStatus;
  readonly beforeContentBase64?: string;
  readonly afterContentBase64?: string;
}

export interface SnapshotPatchArtifact {
  readonly version: 1;
  readonly checkpointId: string;
  readonly patchId: string;
  readonly createdAt: number;
  readonly files: readonly SnapshotFilePatch[];
}

export interface ComputedSnapshotPatch {
  readonly files: readonly FileDiff[];
  readonly filePatches: readonly SnapshotFilePatch[];
  readonly summary: SnapshotDiffSummary;
  readonly fileCount: number;
}

export interface TrackSnapshotParams {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly workdir: string;
  readonly workspaceSource?: WorkspaceSource;
  readonly messageCursorBefore?: MessageCursor;
}

export interface CaptureSnapshotParams {
  readonly checkpointId: string;
  readonly messageCursorAfter?: MessageCursor;
}

export interface RestoreSnapshotParams {
  readonly checkpointId: string;
}

export interface RestoreSnapshotResult {
  readonly messageCursorBefore?: MessageCursor;
}

export interface DiffSnapshotParams {
  readonly fromCheckpointId: string;
  readonly toCheckpointId?: string;
}

export interface ListCheckpointOptions {
  readonly runId?: string;
  readonly turnId?: string;
}

export interface CreateCheckpointInput extends TrackSnapshotParams {
  readonly checkpointId: string;
  readonly createdAt: number;
}

export interface CreatePatchInput {
  readonly patchId: string;
  readonly checkpointId: string;
  readonly artifactPath: string | null;
  readonly fileCount: number;
  readonly createdAt: number;
}

export interface ActiveWriterCheckContext {
  readonly checkpoint: SnapshotCheckpoint;
}

export type ActiveWriterChecker = (
  context: ActiveWriterCheckContext,
) => boolean | Promise<boolean>;

export interface SnapshotRunWorkerHookContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly workdir?: string;
  readonly workspaceSource?: WorkspaceSource;
  readonly messageCursor?: MessageCursor;
}

export interface SnapshotRunWorkerHookState {
  readonly checkpointId?: string;
}

export interface SnapshotRunWorkerHook {
  track(
    context: SnapshotRunWorkerHookContext,
  ): Promise<SnapshotCheckpoint | undefined>;
  capture(
    context: SnapshotRunWorkerHookContext,
    state: SnapshotRunWorkerHookState,
  ): Promise<SnapshotPatch | undefined>;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SnapshotCheckpointNotFoundError extends SnapshotError {
  constructor(readonly checkpointId: string) {
    super(`Snapshot checkpoint not found: ${checkpointId}`);
  }
}

export class SnapshotPatchNotFoundError extends SnapshotError {
  constructor(readonly patchId: string) {
    super(`Snapshot patch not found: ${patchId}`);
  }
}

export class SnapshotBaselineNotFoundError extends SnapshotError {
  constructor(readonly checkpointId: string) {
    super(`Snapshot baseline not found: ${checkpointId}`);
  }
}

export class ArtifactNotAvailableError extends SnapshotError {
  constructor(
    readonly patchId: string,
    readonly checkpointId?: string,
  ) {
    super(
      checkpointId
        ? `Snapshot artifact is not available for patch ${patchId} on checkpoint ${checkpointId}`
        : `Snapshot artifact is not available for patch ${patchId}`,
    );
  }
}

export class SnapshotConflictError extends SnapshotError {
  constructor(readonly checkpointId: string) {
    super(`Snapshot restore has an active writer for checkpoint ${checkpointId}`);
  }
}

export class InvalidSnapshotArtifactError extends SnapshotError {
  constructor(message: string) {
    super(`Invalid snapshot artifact: ${message}`);
  }
}
