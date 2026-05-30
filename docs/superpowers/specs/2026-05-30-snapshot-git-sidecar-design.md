# Snapshot Git Sidecar Engine Design

Date: 2026-05-30

## Summary

Replace the current in-memory `ShadowDiffEngine` and base64 artifact storage with
a sidecar git repository per workdir, while keeping ohbaby's SQLite metadata
layer, message cursors, run-hook integration, idempotent capture behavior, and
default-disabled snapshot switch.

The implementation scope is P0 plus core P1. P2 items, command alignment, CLI
flags, TUI entry points, and TUI store renaming are out of scope for this batch.
Existing snapshot docs will be updated separately after the implementation is
settled.

## Goals

- Make snapshot baselines durable across process restarts.
- Use git for file content storage, diffing, restore, ignore handling, and GC.
- Preserve `SnapshotService`, `SnapshotStore`, `MessageCursor`, checkpoint and
  patch metadata, run-hook adapter behavior, and capture idempotency.
- Keep snapshots disabled by default. This batch uses the existing
  programmatic `enableSnapshots: true` switch only.
- Provide reliable `track -> capture -> diff -> restore` behavior.
- Make hook failures observable without blocking agent runs.
- Run multiple API-key-backed E2E passes using the existing `.env` loading path,
  without printing secrets.

## Non-Goals

- Do not add CLI flags or commands.
- Do not add TUI entry points.
- Do not rename `packages/ohbaby-cli/src/tui/store/snapshot.ts`.
- Do not implement selective patch or file revert.
- Do not introduce a plugin-style engine abstraction.
- Do not migrate to a single error-code registry.
- Do not backfill old base64 artifact data into git objects.

## Architecture

`SnapshotService` remains the public orchestration layer. It owns checkpoint and
patch lifecycle semantics, message cursor updates, active writer checks, and
capture locks.

`SnapshotStore` remains the SQLite metadata layer. It stores checkpoint and
patch rows, but no longer owns large artifact files.

`GitSnapshotEngine` replaces `ShadowDiffEngine`. It creates and uses a sidecar
git repository outside the workdir:

```text
<snapshotRoot>/snapshot-git/<sha1(workdir).slice(0,16)>
```

The sidecar gitdir is derived lazily from the workdir on each engine call. This
is required because the default snapshot service is constructed as a process
singleton before any per-run workdir is known.

Each gitdir has a process-local serial lock. All operations that mutate the
sidecar index, refs, or object graph run under that lock.

## Git Engine Contract

The new `DiffEngine` contract should expose these operations:

- `recordBaseline(checkpointId, workdir) -> Promise<string>`
  Creates the pre commit and updates `refs/snapshots/<checkpointId>`.

- `computeDiff(checkpoint) -> Promise<ComputedSnapshotPatch>`
  Requires `checkpoint.preTreeRef`. Creates the post commit, updates
  `refs/snapshots/<checkpointId>/post`, and returns file-level diff metadata
  plus the post commit.

- `diffWorkingTree(checkpoint) -> Promise<readonly FileDiff[]>`
  Diffs the pre commit against the current workdir by refreshing the private
  sidecar index. It must not create a post commit or update a post ref.

- `diffBetween(workdir, fromCommit, toCommit) -> Promise<readonly FileDiff[]>`
  Diffs two snapshot commits.

- `restoreTo(workdir, commit) -> Promise<void>`
  Restores the whole workdir to the commit, including deletion of files created
  after the checkpoint.

- `dropRef(checkpointId, workdir) -> Promise<void>`
  Deletes both the pre and post refs for a checkpoint.

- `gc(workdir, prune?) -> Promise<void>`
  Runs sidecar git GC. Production default is `7.days`; deterministic tests may
  pass `now`.

## Git Command Semantics

All git commands use the sidecar gitdir and real worktree. The engine should
carry over the Windows-sensitive config from opencode:

```text
core.longpaths=true
core.symlinks=true
core.autocrlf=false
core.quotepath=false for path-producing commands
```

Initialization uses `GIT_DIR` and `GIT_WORK_TREE` environment variables for
`git init`, then configures the sidecar repository. Other commands use
`--git-dir <gitdir> --work-tree <workdir>`.

Baseline and post capture use:

```text
git add --all .
git write-tree
git commit-tree <tree>
git update-ref <ref> <commit>
```

Diffs use `git diff --no-ext-diff --name-status --no-renames`.

Restore uses:

```text
git add --all .
git read-tree -u --reset <commit>
```

The `read-tree -u --reset` path is required because plain `checkout-index -a -f`
does not delete files that were added after the checkpoint.

## Data Model And Migration

Add a migration after the current database migrations:

```sql
ALTER TABLE snapshot_checkpoint ADD COLUMN pre_tree_ref TEXT;
ALTER TABLE snapshot_patch ADD COLUMN post_tree_ref TEXT;
```

Keep `artifact_path` for old rows and schema compatibility, but new code does
not read or write patch artifacts.

Type updates:

- `SnapshotCheckpoint` gains `preTreeRef?: string`.
- `SnapshotPatch` replaces active use of `artifactPath` with
  `postTreeRef: string | null`.
- `ComputedSnapshotPatch` removes `filePatches` and adds `commit: string`.
- Artifact types and artifact parse/serialize helpers are removed from the
  active API.

Old rows with `pre_tree_ref IS NULL` are treated as old-engine data. `diff`,
`capture`, and `restore` should throw `SnapshotEngineMismatchError` with a
clear message rather than producing partial or misleading results.

## Service Semantics

`track()` should generate the checkpoint id, ask the engine to create the pre
commit, then create the checkpoint row with `preTreeRef`. This avoids leaving a
new DB checkpoint row that has no baseline if git capture fails.

`capture()` preserves the existing `captureLocks` behavior and
`createPatchIfAbsent` transaction. It stores the post commit in
`postTreeRef`.

`diff(from)` calls `diffWorkingTree`. It must not call `computeDiff` and must
not create or overwrite a post ref.

`diff(from, to)` compares `from.preTreeRef` and `to.preTreeRef`.

`restore(checkpointId)` keeps the active writer check. If safe, it calls
`restoreTo(checkpoint.workdir, checkpoint.preTreeRef)` and returns
`messageCursorBefore`.

`revert(patches[])` remains present for compatibility, but this batch does not
define selective patch revert semantics. It throws
`SnapshotOperationNotSupportedError` and directs callers to
`restore(checkpointId)` for this batch.

`listCheckpoints`, `getCheckpoint`, and `getPatches` should become synchronous
wrappers over the synchronous store methods instead of returning
`Promise.resolve(...)`.

## Hook Observability

Run hooks remain observer-style: a snapshot hook failure must not stop the main
run. The empty catch in `RunWorker.executeHook` should publish a
`snapshot.hook.failed` event to the current run scope with:

- hook point (`pre-run` or `post-run`)
- error message
- enough context to diagnose the failing run

Publish failure remains swallowed by the existing `publish` helper.

No-git behavior follows the same observer rule. `GitNotAvailableError` should
be visible through the hook failure event when snapshots are enabled, but the
agent run should continue.

## Errors

Keep the current snapshot error subclass model. Add:

- `GitNotAvailableError`
- `GitCommandError`
- `SnapshotEngineMismatchError`
- `SnapshotOperationNotSupportedError`

Remove active uses of artifact-only errors after the artifact path is removed
from the implementation.

## Testing Plan

Engine unit tests:

- sidecar initialization and pre ref creation
- pre commit contains non-ignored files
- added, modified, and deleted file detection
- `.gitignore` behavior
- `restoreTo` restores modified files and deletes newly added files
- `diffWorkingTree` has no post ref side effect
- `diffBetween` returns the net diff between two commits
- post commit survives `gc(now)` while its post ref exists
- `dropRef` plus `gc(now)` makes deleted checkpoint commits unreachable
- single-gitdir lock handles concurrent operations
- CRLF and non-ASCII filename smoke coverage on Windows
- missing git maps to `GitNotAvailableError`
- non-zero git exits map to `GitCommandError`

Service and store tests:

- `track` stores `preTreeRef`
- `capture` stores `postTreeRef`
- repeated and concurrent capture is idempotent
- cursor before and after semantics remain intact
- `diff(from)` calls `diffWorkingTree`
- `diff(from, to)` calls `diffBetween`
- active writer conflict prevents restore
- old-engine NULL `preTreeRef` rows throw `SnapshotEngineMismatchError`
- `revert()` throws `SnapshotOperationNotSupportedError`
- list/get methods return synchronously

Adapter and hook tests:

- default disabled mode does not install the snapshot executor
- `enableSnapshots: true` installs the snapshot executor programmatically
- hook failure publishes `snapshot.hook.failed`
- hook failure does not stop the run
- missing git while snapshots are enabled is observable and non-fatal to the run

Integration tests:

- `track -> capture -> diff -> restore` with real sidecar git
- simulated restart: track with one engine instance, capture with another
- multiple checkpoints and restore to historical checkpoint
- `.gitignore` end to end
- ref lifecycle and GC behavior

API-key E2E tests:

- Run multiple real agent E2E passes with snapshots enabled and API keys loaded
  from `.env`.
- Cover at least normal file modification, restart/capture or restart/restore,
  and restore followed by another run.
- Never print key values or environment dumps.

## Review Gate

After implementation and primary verification pass, run an independent subagent
review before final completion. The review should focus on:

- git-sidecar lifecycle and ref reachability
- schema and old-data migration safety
- service idempotency and cursor semantics
- hook observability and no-git behavior
- test coverage gaps and E2E reliability

Any actionable review findings must be fixed and re-verified before declaring
the batch complete.

