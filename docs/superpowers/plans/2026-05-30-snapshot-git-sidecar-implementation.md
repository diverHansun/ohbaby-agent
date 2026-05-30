# Snapshot Git Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace snapshot's in-memory/base64 artifact engine with a durable git-sidecar engine while preserving ohbaby checkpoint metadata, message cursors, observer hook behavior, and default-disabled snapshot activation.

**Architecture:** `SnapshotService` remains the orchestration API and `SnapshotStore` remains the SQLite metadata layer. `GitSnapshotEngine` owns sidecar gitdirs derived lazily per workdir, stores pre/post commits as sibling refs, and exposes restore/diff/gc primitives. Snapshot hook errors are attributed through a snapshot-specific error wrapper so generic hook failures are not mislabeled.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs/promises`, SQLite via existing database services, git CLI, Vitest, pnpm, existing `.env` API-key loading path.

---

## File Map

- Modify `packages/ohbaby-agent/src/snapshot/types.ts`
  Add git-engine fields and errors; remove active artifact types from the public snapshot surface.
- Modify `packages/ohbaby-agent/src/snapshot/diff-engine.ts`
  Replace `ShadowDiffEngine` with `GitSnapshotEngine`, git command helpers, sidecar path derivation, ref lifecycle, and summary helpers.
- Modify `packages/ohbaby-agent/src/snapshot/store.ts`
  Remove `Storage` dependency and artifact methods; add `pre_tree_ref`/`post_tree_ref`, checkpoint deletion, and same session/workdir validation helper.
- Modify `packages/ohbaby-agent/src/snapshot/service.ts`
  Rewire track/capture/diff/restore/revert/delete/gc to git commits and new store API.
- Modify `packages/ohbaby-agent/src/snapshot/run-hook-adapter.ts`
  Wrap snapshot hook failures in `SnapshotHookExecutionError`.
- Modify `packages/ohbaby-agent/src/snapshot/index.ts`
  Export new engine/errors and remove artifact helper exports.
- Modify `packages/ohbaby-agent/src/services/database/schema.ts`
  Add schema mappings for `preTreeRef` and `postTreeRef`.
- Modify `packages/ohbaby-agent/src/services/database/migrations.ts`
  Add migration `005_snapshot_git_sidecar`.
- Modify `packages/ohbaby-agent/src/adapters/ui-persistent.ts`
  Construct `GitSnapshotEngine` with snapshot root derived from `storageRoot`; remove snapshot storage construction.
- Modify `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`
  Publish `snapshot.hook.failed` only for `SnapshotHookExecutionError`.
- Modify tests under `packages/ohbaby-agent/src/snapshot/`
  Rewrite engine and integration tests for real git sidecar behavior.
- Modify tests under `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`
  Cover hook failure attribution and default-disabled/programmatic-enabled snapshot behavior.
- Add `packages/ohbaby-agent/src/snapshot/snapshot.e2e.test.ts`
  Explicit API-key E2E harness that is not part of the default `pnpm test` command.

---

## Task 1: Schema, Types, And Store Contract

**Files:**
- Modify: `packages/ohbaby-agent/src/services/database/schema.ts`
- Modify: `packages/ohbaby-agent/src/services/database/migrations.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/types.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/store.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts`

- [ ] **Step 1: Write failing store/schema tests**

Add focused assertions in `packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts`:

```ts
it("stores git tree refs on checkpoints and patches", async () => {
  const service = await createService();
  insertSession("session_1");
  const workdir = await tempDir("ohbaby-snapshot-gitrefs-");
  await writeFile(join(workdir, "file.txt"), "before\n", "utf8");

  const checkpoint = await service.track({
    sessionId: "session_1",
    turnId: "turn_1",
    workdir,
  });
  expect(checkpoint.preTreeRef).toMatch(/^[0-9a-f]{40,64}$/);

  await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
  const patch = await service.capture({ checkpointId: checkpoint.checkpointId });

  expect(patch.postTreeRef).toMatch(/^[0-9a-f]{40,64}$/);
  expect(await service.getPatches(checkpoint.checkpointId)).toMatchObject([
    { checkpointId: checkpoint.checkpointId, postTreeRef: patch.postTreeRef },
  ]);
});

it("deletes checkpoint metadata through the store lifecycle", async () => {
  const service = await createService();
  insertSession("session_1");
  const workdir = await tempDir("ohbaby-snapshot-delete-");
  await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
  const checkpoint = await service.track({
    sessionId: "session_1",
    turnId: "turn_1",
    workdir,
  });
  await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
  await service.capture({ checkpointId: checkpoint.checkpointId });

  await service.deleteCheckpoint(checkpoint.checkpointId);

  expect(service.getCheckpoint(checkpoint.checkpointId)).toBeUndefined();
  expect(service.getPatches(checkpoint.checkpointId)).toEqual([]);
});
```

These tests will initially fail because `preTreeRef`, `postTreeRef`, and `deleteCheckpoint` do not exist.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts --passWithNoTests
```

Expected: FAIL with TypeScript/runtime errors for missing `preTreeRef`, `postTreeRef`, or `deleteCheckpoint`.

- [ ] **Step 3: Add schema and migration columns**

Update `schema.ts`:

```ts
snapshotCheckpoint: table("snapshot_checkpoint", {
  checkpointId: "checkpoint_id",
  sessionId: "session_id",
  runId: "run_id",
  turnId: "turn_id",
  workdir: "workdir",
  workspaceSource: "workspace_source",
  messageCursorBefore: "message_cursor_before",
  messageCursorAfter: "message_cursor_after",
  preTreeRef: "pre_tree_ref",
  createdAt: "created_at",
}),
snapshotPatch: table("snapshot_patch", {
  patchId: "patch_id",
  checkpointId: "checkpoint_id",
  artifactPath: "artifact_path",
  postTreeRef: "post_tree_ref",
  fileCount: "file_count",
  createdAt: "created_at",
}),
```

Append migration in `migrations.ts`:

```ts
{
  version: "005_snapshot_git_sidecar",
  sql: `
    ALTER TABLE snapshot_checkpoint ADD COLUMN pre_tree_ref TEXT;
    ALTER TABLE snapshot_patch ADD COLUMN post_tree_ref TEXT;
  `,
},
```

- [ ] **Step 4: Update types**

In `types.ts`, add git fields:

```ts
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

export interface ComputedSnapshotPatch {
  readonly files: readonly FileDiff[];
  readonly summary: SnapshotDiffSummary;
  readonly fileCount: number;
  readonly commit: string;
}
```

Update `CreateCheckpointInput` and `CreatePatchInput`:

```ts
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
```

Add errors:

```ts
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
    super(`Git command failed (${args.join(" ")}): ${stderr || String(exitCode)}`);
  }
}

export class SnapshotEngineMismatchError extends SnapshotError {
  constructor(readonly checkpointId: string) {
    super(`Snapshot checkpoint ${checkpointId} was created by an older snapshot engine and cannot be used by the git sidecar engine`);
  }
}

export class SnapshotOperationNotSupportedError extends SnapshotError {
  constructor(readonly operation: string) {
    super(`Snapshot operation is not supported in this batch: ${operation}`);
  }
}

export class SnapshotHookExecutionError extends SnapshotError {
  constructor(
    readonly point: "pre-run" | "post-run",
    readonly cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Snapshot hook failed during ${point}: ${message}`);
  }
}
```

- [ ] **Step 5: Update store metadata methods**

In `store.ts`, remove `Storage` imports and methods. Update row types and mappers:

```ts
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
```

Select/insert `pre_tree_ref` and `post_tree_ref` in all queries. Return `preTreeRef` only when non-null and `postTreeRef` as nullable.

Add:

```ts
deleteCheckpoint(checkpointId: string): void {
  this.options.db
    .prepare(
      `DELETE FROM ${schema.snapshotCheckpoint.tableName}
       WHERE checkpoint_id = ?`,
    )
    .run(checkpointId);
}
```

Keep `listPatchesBetweenCheckpoints` same-session/workdir validation.

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts --passWithNoTests
pnpm typecheck
```

Expected: snapshot tests may still fail because engine/service are not migrated yet; typecheck should guide remaining references to artifact fields.

- [ ] **Step 7: Commit metadata layer**

Run after green enough for this task's type surface:

```powershell
git add packages/ohbaby-agent/src/services/database/schema.ts packages/ohbaby-agent/src/services/database/migrations.ts packages/ohbaby-agent/src/snapshot/types.ts packages/ohbaby-agent/src/snapshot/store.ts packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts
git commit -m "feat(snapshot): add git ref metadata schema"
```

---

## Task 2: GitSnapshotEngine

**Files:**
- Modify: `packages/ohbaby-agent/src/snapshot/diff-engine.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/diff-engine.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/index.ts`

- [ ] **Step 1: Replace old engine tests with git-sidecar RED tests**

In `diff-engine.unit.test.ts`, test real git behavior. Include helpers:

```ts
async function tempRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function checkpoint(workdir: string, preTreeRef: string): SnapshotCheckpoint {
  return {
    checkpointId: "checkpoint_1",
    sessionId: "session_1",
    turnId: "turn_1",
    workdir,
    preTreeRef,
    createdAt: 1,
  };
}
```

Add these tests with real workdir files and assertions:

- `creates sibling pre and post refs without git ref collision`: call
  `recordBaseline`, modify `file.txt`, call `computeDiff`, then verify
  `git --git-dir <gitdir> rev-parse refs/snapshots/checkpoint_1/pre` and
  `refs/snapshots/checkpoint_1/post` both resolve.
- `uses a fixed commit identity when global git identity is unavailable`:
  create a temporary empty HOME/USERPROFILE, call `recordBaseline`, and assert a
  commit SHA is returned.
- `computes added modified and deleted file diffs`: create `modified.txt` and
  `deleted.txt`, track, add `added.txt`, modify/delete the originals, capture,
  and assert summary `{ added: 1, modified: 1, deleted: 1 }`.
- `respects .gitignore for untracked ignored files`: write `.gitignore` with
  `build/`, create `build/out.txt`, track/capture, and assert no diff entry for
  `build/out.txt`.
- `restores tracked files and deletes tracked files added after the checkpoint`:
  track `file.txt`, create `tracked-new.txt` before post capture, capture,
  restore to pre, then assert `tracked-new.txt` is missing and `file.txt` has
  original bytes.
- `leaves ignored untracked files alone during restore`: write `.gitignore`
  with `ignored.txt`, track, create `ignored.txt`, restore, and assert
  `ignored.txt` still exists.
- `diffWorkingTree does not create a post ref`: track, modify a file, call
  `diffWorkingTree`, then assert `git rev-parse refs/snapshots/checkpoint_1/post`
  exits non-zero.
- `drops refs and allows gc now to prune deleted checkpoint commits`: create pre
  and post commits, call `dropRef` and `gc(workdir, "now")`, then assert
  `git cat-file -e <pre>` and `git cat-file -e <post>` exit non-zero.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/diff-engine.unit.test.ts --passWithNoTests
```

Expected: FAIL because `GitSnapshotEngine` and new `DiffEngine` methods do not exist.

- [ ] **Step 3: Implement git command helpers and path derivation**

In `diff-engine.ts`, create:

```ts
interface GitSnapshotEngineOptions {
  readonly snapshotRoot?: string;
  readonly gitCommand?: string;
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "ohbaby-agent",
  GIT_AUTHOR_EMAIL: "snapshot@ohbaby.local",
  GIT_COMMITTER_NAME: "ohbaby-agent",
  GIT_COMMITTER_EMAIL: "snapshot@ohbaby.local",
} as const;
```

Use `createHash("sha1").update(resolve(workdir)).digest("hex").slice(0, 16)` for gitdir names.

Use `execFile` promisified with `{ cwd, env }`. Convert `ENOENT` to `GitNotAvailableError` and non-zero exits to `GitCommandError`.

- [ ] **Step 4: Implement `GitSnapshotEngine` methods**

Implement the new interface:

```ts
export interface DiffEngine {
  recordBaseline(checkpointId: string, workdir: string): Promise<string>;
  computeDiff(checkpoint: SnapshotCheckpoint): Promise<ComputedSnapshotPatch>;
  diffWorkingTree(checkpoint: SnapshotCheckpoint): Promise<readonly FileDiff[]>;
  restoreTo(workdir: string, commit: string): Promise<void>;
  diffBetween(workdir: string, from: string, to: string): Promise<readonly FileDiff[]>;
  dropRef(checkpointId: string, workdir: string): Promise<void>;
  gc(workdir: string, prune?: string): Promise<void>;
}
```

Use sibling refs:

```ts
function preRef(checkpointId: string): string {
  return `refs/snapshots/${checkpointId}/pre`;
}

function postRef(checkpointId: string): string {
  return `refs/snapshots/${checkpointId}/post`;
}
```

Parse `name-status` lines into `FileDiff[]`, mapping `A` to `added`, `D` to `deleted`, and everything else to `modified`.

- [ ] **Step 5: Run engine tests to verify GREEN**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/diff-engine.unit.test.ts --passWithNoTests
pnpm typecheck
```

Expected: engine tests PASS. Typecheck may still fail because service/store are
rewired in Task 3.

- [ ] **Step 6: Commit engine**

```powershell
git add packages/ohbaby-agent/src/snapshot/diff-engine.ts packages/ohbaby-agent/src/snapshot/diff-engine.unit.test.ts packages/ohbaby-agent/src/snapshot/index.ts
git commit -m "feat(snapshot): add git sidecar engine"
```

---

## Task 3: SnapshotService Rewire

**Files:**
- Modify: `packages/ohbaby-agent/src/snapshot/service.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts`

- [ ] **Step 1: Add service RED tests**

Add tests in `snapshot.integration.test.ts`:

```ts
it("diffs between checkpoints only in the same session and workdir", async () => {
  const service = await createService();
  insertSession("session_1");
  insertSession("session_2");
  const workdirA = await tempDir("ohbaby-snapshot-workdir-a-");
  const workdirB = await tempDir("ohbaby-snapshot-workdir-b-");
  const first = await service.track({ sessionId: "session_1", turnId: "turn_1", workdir: workdirA });
  const second = await service.track({ sessionId: "session_2", turnId: "turn_2", workdir: workdirB });

  await expect(
    service.diff({ fromCheckpointId: first.checkpointId, toCheckpointId: second.checkpointId }),
  ).rejects.toThrow(/different sessions or workdirs/);
});

it("throws an explicit mismatch error for old-engine checkpoints", async () => {
  const service = await createService();
  insertSession("session_1");
  const workdir = await tempDir("ohbaby-snapshot-old-engine-");
  service.store.createCheckpoint({
    checkpointId: "checkpoint_old",
    sessionId: "session_1",
    turnId: "turn_1",
    workdir,
    preTreeRef: null as never,
    createdAt: 1,
  });

  await expect(service.restore({ checkpointId: "checkpoint_old" })).rejects.toThrow(SnapshotEngineMismatchError);
});

it("does not support selective patch revert in this batch", async () => {
  const service = await createService();
  await expect(service.revert([])).rejects.toThrow(SnapshotOperationNotSupportedError);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts --passWithNoTests
```

Expected: FAIL while service still uses artifacts/applyReverse.

- [ ] **Step 3: Rewire service methods**

Implement:

- `track`: generate id, `recordBaseline`, `store.createCheckpoint` with `preTreeRef`; on DB error, `dropRef` best-effort then rethrow.
- `capture`: require checkpoint with `preTreeRef`; `computeDiff`; `createPatchIfAbsent` with `postTreeRef`; on DB error, delete post ref only.
- `diff(from)`: `diffWorkingTree`.
- `diff(from,to)`: use existing same session/workdir validation and `diffBetween`.
- `restore`: active writer check then `restoreTo`.
- `revert`: throw `SnapshotOperationNotSupportedError`.
- `deleteCheckpoint`: load checkpoint and patch refs, drop refs, delete DB row, best-effort restore refs if DB delete fails.
- `gc`: delegate to engine.

Remove artifact loading/persist helpers and `parsePatchArtifact` usage.

- [ ] **Step 4: Update test factory**

In `snapshot.integration.test.ts`, `createService` should construct:

```ts
const snapshotRoot = await tempDir("ohbaby-snapshot-sidecar-");
const store = new SnapshotStore({ db: getDatabase() });
return new SnapshotService({
  store,
  diffEngine: new GitSnapshotEngine({ snapshotRoot }),
  createCheckpointId: () => `checkpoint_${String(++checkpointCounter)}`,
  createPatchId: () => `patch_${String(++patchCounter)}`,
  now: () => now++,
});
```

- [ ] **Step 5: Run service tests to verify GREEN**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts --passWithNoTests
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit service rewire**

```powershell
git add packages/ohbaby-agent/src/snapshot/service.ts packages/ohbaby-agent/src/snapshot/snapshot.integration.test.ts
git commit -m "feat(snapshot): rewire service to git commits"
```

---

## Task 4: Hook Attribution And Persistent Adapter

**Files:**
- Modify: `packages/ohbaby-agent/src/snapshot/run-hook-adapter.ts`
- Modify: `packages/ohbaby-agent/src/snapshot/run-hook-adapter.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`
- Modify: `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`

- [ ] **Step 1: Add RED tests for hook attribution**

Add/extend tests so:

```ts
it("wraps snapshot hook failures with point context", async () => {
  const service = {
    track: async () => {
      throw new Error("git missing");
    },
  } as unknown as SnapshotService;
  const executor = createSnapshotHookExecutor({ service });

  await expect(
    executor.execute("pre-run", {
      run: {
        createdAt: 1,
        disconnectMode: "continue",
        multitaskStrategy: "reject",
        permissionProfileId: "interactive",
        runId: "run_1",
        sessionId: "session_1",
        status: "pending",
        triggerSource: "user",
      },
      runId: "run_1",
      sessionId: "session_1",
      status: "pending",
      triggerSource: "user",
    }),
  ).rejects.toThrow(SnapshotHookExecutionError);
});
```

Add run worker/manager test:

- `publishes snapshot hook failures without mislabeling ordinary hook failures`:
  use the existing recording bridge fixture. In one run, set `hookExecutor` to
  throw `new SnapshotHookExecutionError("pre-run", new Error("git missing"))`
  and assert the bridge contains exactly one `snapshot.hook.failed` event. In a
  second run, set `hookExecutor` to throw `new Error("ordinary hook failed")`
  and assert the bridge contains zero `snapshot.hook.failed` events.
- `runs snapshot executor even if an earlier observer hook fails`: compose an
  ordinary failing hook before a snapshot hook in the same way
  `ui-persistent.ts` composes hooks, run `pre-run`, and assert the snapshot
  service `track` spy was called.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/run-hook-adapter.unit.test.ts packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts --passWithNoTests
```

Expected: FAIL until hook wrapping/publishing exists.

- [ ] **Step 3: Implement snapshot hook error wrapping**

In `run-hook-adapter.ts`, wrap errors thrown by `hook.track`/`hook.capture`:

```ts
try {
  if (point === "pre-run") {
    return await executePreRunSnapshot(context);
  }
  return await executePostRunSnapshot(context);
} catch (error) {
  throw new SnapshotHookExecutionError(point, error);
}
```

Ensure state cleanup still happens on post-run failure.

- [ ] **Step 4: Implement run worker publish guard**

In `worker.ts`:

```ts
} catch (error) {
  if (error instanceof SnapshotHookExecutionError) {
    this.publish(`run/${context.runId}`, "snapshot.hook.failed", {
      point: error.point,
      error: error.cause instanceof Error ? error.cause.message : String(error.cause),
    });
  }
}
```

Import `SnapshotHookExecutionError` from snapshot without creating a broad runtime dependency cycle.

- [ ] **Step 5: Update persistent adapter**

Replace `ShadowDiffEngine` with:

```ts
diffEngine: new GitSnapshotEngine({
  snapshotRoot: resolveSnapshotRoot(input.storageRoot),
}),
store: new SnapshotStore({ db: input.db }),
```

Keep `enableSnapshots === true`. Do not add CLI flags.

- [ ] **Step 6: Run hook/adapter tests**

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot/run-hook-adapter.unit.test.ts packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts --passWithNoTests
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit hook and adapter**

```powershell
git add packages/ohbaby-agent/src/snapshot/run-hook-adapter.ts packages/ohbaby-agent/src/snapshot/run-hook-adapter.unit.test.ts packages/ohbaby-agent/src/runtime/run-manager/worker.ts packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts
git commit -m "feat(snapshot): wire git sidecar into run hooks"
```

---

## Task 5: E2E Harness With API Keys

**Files:**
- Add: `packages/ohbaby-agent/src/snapshot/snapshot.e2e.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add explicit E2E harness**

Add a test file excluded from default test naming if necessary, or add a dedicated script that runs only when invoked:

```json
"test:e2e:snapshot": "vitest run packages/ohbaby-agent/src/snapshot/snapshot.e2e.test.ts --runInBand"
```

The E2E must:

- load `.env` via the existing application path or `dotenv/config`
- skip with a clear message only if no provider API key is present
- create a temp workdir and temp db/storage/snapshot root
- create a persistent UI backend with `enableSnapshots: true`
- prompt the real agent to modify a file in the temp workdir
- verify checkpoint/patch metadata and sidecar refs
- call `restore()` through the service or test hook and verify file restoration

- [ ] **Step 2: Run E2E once to verify RED or skip condition**

Run:

```powershell
pnpm run test:e2e:snapshot
```

Expected before implementation wiring is complete: FAIL for missing behavior, or SKIP only if `.env` truly has no usable key.

- [ ] **Step 3: Complete E2E wiring**

Expose only the test-only service access needed for the E2E through local test construction, not public SDK API. Do not print env values.

- [ ] **Step 4: Run E2E multiple times**

Run at least:

```powershell
pnpm run test:e2e:snapshot
pnpm run test:e2e:snapshot
pnpm run test:e2e:snapshot
```

Expected: PASS each time with snapshots enabled and real API-key-backed agent behavior.

- [ ] **Step 5: Commit E2E harness**

```powershell
git add package.json packages/ohbaby-agent/src/snapshot/snapshot.e2e.test.ts
git commit -m "test(snapshot): add api backed e2e coverage"
```

---

## Task 6: Full Verification And Review

**Files:**
- No planned production changes. Fix files found by verification or review.

- [ ] **Step 1: Run focused snapshot tests**

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot --passWithNoTests
```

Expected: PASS.

- [ ] **Step 2: Run broader checks**

```powershell
pnpm lint
pnpm typecheck
pnpm test
```

Expected: PASS. Existing warnings must be reported if lint returns zero with warnings.

- [ ] **Step 3: Run API-key E2E three times**

```powershell
pnpm run test:e2e:snapshot
pnpm run test:e2e:snapshot
pnpm run test:e2e:snapshot
```

Expected: PASS all three runs, no secrets printed.

- [ ] **Step 4: Dispatch subagent code review**

Ask a subagent to review the implemented branch for:

- git-sidecar lifecycle and ref reachability
- schema migration safety
- old data behavior
- hook attribution
- default-disabled behavior
- E2E/test gaps

Expected: no blocking findings. Fix actionable findings, rerun relevant tests, and commit fixes.

- [ ] **Step 5: Commit verification fixes if any**

```powershell
git status --short
git add packages/ohbaby-agent/src/snapshot packages/ohbaby-agent/src/services/database packages/ohbaby-agent/src/adapters packages/ohbaby-agent/src/runtime package.json docs/superpowers/plans/2026-05-30-snapshot-git-sidecar-implementation.md
git commit -m "fix(snapshot): address verification findings"
```

Only commit if there are actual fixes.

---

## Task 7: Merge Back To mvp

**Files:**
- Git branch state only unless merge conflicts require edits.

- [ ] **Step 1: Verify branch is clean**

```powershell
git status --short
```

Expected: no tracked changes.

- [ ] **Step 2: Switch main worktree to mvp and merge**

From the original repo root:

```powershell
git -C D:\Projects\Code-cli\ohbaby-agent status --short
git -C D:\Projects\Code-cli\ohbaby-agent switch mvp
git -C D:\Projects\Code-cli\ohbaby-agent merge --no-ff codex/snapshot-git-sidecar
```

Expected: merge succeeds. The original root still has unrelated untracked
`docs/snapshot/improve-1/` and `pi/`; do not stage or remove them.

- [ ] **Step 3: Run post-merge smoke checks on mvp**

```powershell
pnpm vitest run packages/ohbaby-agent/src/snapshot --passWithNoTests
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Report final evidence**

Final response should include:

- branch name and merge status
- commits created
- tests run and results
- E2E run count and result
- subagent review result
- note that unrelated untracked files were preserved
