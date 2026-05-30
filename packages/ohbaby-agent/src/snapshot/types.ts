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
  readonly preTreeRef?: string;
  readonly createdAt: number;
}

export interface SnapshotPatch {
  readonly patchId: string;
  readonly checkpointId: string;
  readonly postTreeRef: string | null;
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

export interface ComputedSnapshotPatch {
  readonly files: readonly FileDiff[];
  readonly summary: SnapshotDiffSummary;
  readonly fileCount: number;
  readonly commit: string;
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
  readonly preTreeRef: string;
  readonly createdAt: number;
}

export interface CreatePatchInput {
  readonly patchId: string;
  readonly checkpointId: string;
  readonly postTreeRef: string | null;
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

export class SnapshotConflictError extends SnapshotError {
  constructor(readonly checkpointId: string) {
    super(
      `Snapshot restore has an active writer for checkpoint ${checkpointId}`,
    );
  }
}

export class GitNotAvailableError extends SnapshotError {
  constructor(readonly command = "git") {
    super(`Git is not available on PATH: ${command}`);
  }
}

export class GitCommandError extends SnapshotError {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `Git command failed (${args.join(" ")}): ${stderr || String(exitCode)}`,
    );
  }
}

export class SnapshotEngineMismatchError extends SnapshotError {
  constructor(readonly checkpointId: string) {
    super(
      `Snapshot checkpoint ${checkpointId} was created by an older snapshot engine and cannot be used by the git sidecar engine`,
    );
  }
}

export class SnapshotOperationNotSupportedError extends SnapshotError {
  constructor(readonly operation: string) {
    super(`Snapshot operation is not supported in this batch: ${operation}`);
  }
}

export class SnapshotHookExecutionError extends SnapshotError {
  override readonly cause: unknown;

  constructor(
    readonly point: "pre-run" | "post-run",
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Snapshot hook failed during ${point}: ${message}`);
    this.cause = cause;
  }
}
