export {
  filesFromArtifact,
  parsePatchArtifact,
  serializePatchArtifact,
  ShadowDiffEngine,
  summaryFromFiles,
} from "./diff-engine.js";
export type { DiffEngine } from "./diff-engine.js";
export { createSnapshotRunWorkerHook, SnapshotService } from "./service.js";
export { createSnapshotHookExecutor } from "./run-hook-adapter.js";
export { SnapshotStore } from "./store.js";
export type { SnapshotHookExecutorOptions } from "./run-hook-adapter.js";
export {
  ArtifactNotAvailableError,
  InvalidSnapshotArtifactError,
  SnapshotBaselineNotFoundError,
  SnapshotCheckpointNotFoundError,
  SnapshotConflictError,
  SnapshotError,
  SnapshotPatchNotFoundError,
} from "./types.js";
export type {
  ActiveWriterCheckContext,
  ActiveWriterChecker,
  CaptureSnapshotParams,
  ComputedSnapshotPatch,
  CreateCheckpointInput,
  CreatePatchInput,
  DiffHunk,
  DiffSnapshotParams,
  FileDiff,
  FileDiffStatus,
  ListCheckpointOptions,
  MessageCursor,
  RestoreSnapshotParams,
  RestoreSnapshotResult,
  SnapshotCheckpoint,
  SnapshotDiff,
  SnapshotDiffSummary,
  SnapshotFilePatch,
  SnapshotPatch,
  SnapshotPatchArtifact,
  SnapshotRunWorkerHook,
  SnapshotRunWorkerHookContext,
  SnapshotRunWorkerHookState,
  TrackSnapshotParams,
  WorkspaceSource,
} from "./types.js";
