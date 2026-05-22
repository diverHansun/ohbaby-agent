import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../services/database/index.js";
import { createStorage, type Storage } from "../services/storage/index.js";
import {
  ArtifactNotAvailableError,
  ShadowDiffEngine,
  SnapshotService,
  SnapshotStore,
} from "./index.js";

const cleanupPaths: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function insertSession(sessionId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      "project_1",
      "/tmp/project",
      "default",
      sessionId,
      "active",
      1,
      1,
      0,
      "{}",
    );
}

function insertRun(sessionId: string, runId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.runLedger.tableName}
        (run_id, session_id, trigger, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(runId, sessionId, "user", "running", 1);
}

async function createService(
  options: { readonly storage?: Storage } = {},
): Promise<SnapshotService> {
  initDatabase({
    dbPath: join(await tempDir("ohbaby-snapshot-db-"), "agent.db"),
  });
  const storage =
    options.storage ??
    createStorage({ rootDir: await tempDir("ohbaby-snapshot-storage-") });
  const store = new SnapshotStore({ db: getDatabase(), storage });
  let checkpointCounter = 0;
  let patchCounter = 0;
  let now = 1_000;

  return new SnapshotService({
    store,
    diffEngine: new ShadowDiffEngine(),
    createCheckpointId: () => `checkpoint_${String(++checkpointCounter)}`,
    createPatchId: () => `patch_${String(++patchCounter)}`,
    now: () => now++,
  });
}

beforeEach(() => {
  closeDatabase();
});

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("snapshot MVP", () => {
  it("tracks, captures, diffs, and restores added, modified, and deleted files", async () => {
    const service = await createService();
    insertSession("session_1");
    insertRun("session_1", "run_1");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "modified.txt"), "before\n", "utf8");
    await writeFile(join(workdir, "deleted.txt"), "remove me\n", "utf8");

    const checkpoint = await service.track({
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      workdir,
      messageCursorBefore: { sequence: 10, messageId: "message_before" },
    });

    await writeFile(join(workdir, "modified.txt"), "after\n", "utf8");
    await writeFile(join(workdir, "added.txt"), "new\n", "utf8");
    await rm(join(workdir, "deleted.txt"));

    const patch = await service.capture({
      checkpointId: checkpoint.checkpointId,
      messageCursorAfter: { sequence: 20, messageId: "message_after" },
    });

    expect(patch.fileCount).toBe(3);
    expect(patch.artifactPath).toBeTypeOf("string");

    const diff = await service.diff({
      fromCheckpointId: checkpoint.checkpointId,
    });
    expect(diff.summary).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(diff.files.map((file) => [file.path, file.status]).sort()).toEqual([
      ["added.txt", "added"],
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
    ]);

    const restored = await service.restore({
      checkpointId: checkpoint.checkpointId,
    });

    await expect(readFile(join(workdir, "modified.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(readFile(join(workdir, "deleted.txt"), "utf8")).resolves.toBe(
      "remove me\n",
    );
    await expect(readFile(join(workdir, "added.txt"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
    expect(restored.messageCursorBefore).toEqual({
      sequence: 10,
      messageId: "message_before",
    });

    const storedCheckpoint = await service.getCheckpoint(
      checkpoint.checkpointId,
    );
    expect(storedCheckpoint?.messageCursorAfter).toEqual({
      sequence: 20,
      messageId: "message_after",
    });
  });

  it("creates a legal empty patch when no files changed", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-empty-");
    await writeFile(join(workdir, "same.txt"), "same\n", "utf8");
    const checkpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_empty",
      workdir,
    });

    const patch = await service.capture({
      checkpointId: checkpoint.checkpointId,
    });

    expect(patch.fileCount).toBe(0);
    expect(patch.artifactPath).toBeNull();
    await expect(
      service.restore({ checkpointId: checkpoint.checkpointId }),
    ).resolves.toEqual({ messageCursorBefore: undefined });
  });

  it("returns the existing patch when capture is repeated for a checkpoint", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-idempotent-");
    await writeFile(join(workdir, "file.txt"), "one\n", "utf8");
    const checkpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "two\n", "utf8");

    const first = await service.capture({
      checkpointId: checkpoint.checkpointId,
    });
    const second = await service.capture({
      checkpointId: checkpoint.checkpointId,
    });

    expect(second).toEqual(first);
    expect(await service.getPatches(checkpoint.checkpointId)).toHaveLength(1);
  });

  it("updates the end message cursor when an idempotent capture is retried", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-cursor-retry-");
    await writeFile(join(workdir, "file.txt"), "one\n", "utf8");
    const checkpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "two\n", "utf8");
    await service.capture({ checkpointId: checkpoint.checkpointId });

    await service.capture({
      checkpointId: checkpoint.checkpointId,
      messageCursorAfter: { sequence: 30, messageId: "message_after" },
    });

    await expect(
      service.getCheckpoint(checkpoint.checkpointId),
    ).resolves.toMatchObject({
      messageCursorAfter: { sequence: 30, messageId: "message_after" },
    });
  });

  it("diffs a checkpoint to the current workdir when changes are not captured yet", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-current-diff-");
    await writeFile(join(workdir, "file.txt"), "one\n", "utf8");
    const checkpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "two\n", "utf8");

    const diff = await service.diff({
      fromCheckpointId: checkpoint.checkpointId,
    });

    expect(diff.summary).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(diff.files).toEqual([{ path: "file.txt", status: "modified" }]);
  });

  it("diffs from one checkpoint to the next checkpoint baseline", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-to-checkpoint-diff-");
    await writeFile(join(workdir, "file.txt"), "v0\n", "utf8");
    const firstCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "v1\n", "utf8");
    await service.capture({ checkpointId: firstCheckpoint.checkpointId });

    const secondCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_2",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "v2\n", "utf8");
    await service.capture({ checkpointId: secondCheckpoint.checkpointId });

    const diff = await service.diff({
      fromCheckpointId: firstCheckpoint.checkpointId,
      toCheckpointId: secondCheckpoint.checkpointId,
    });

    expect(diff.summary).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(diff.files).toEqual([{ path: "file.txt", status: "modified" }]);
  });

  it("nets out add-then-delete changes when diffing checkpoint baselines", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-net-diff-");
    const firstCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "temp.txt"), "temporary\n", "utf8");
    await service.capture({ checkpointId: firstCheckpoint.checkpointId });

    const secondCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_2",
      workdir,
    });
    await rm(join(workdir, "temp.txt"));
    await service.capture({ checkpointId: secondCheckpoint.checkpointId });

    const thirdCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_3",
      workdir,
    });

    const diff = await service.diff({
      fromCheckpointId: firstCheckpoint.checkpointId,
      toCheckpointId: thirdCheckpoint.checkpointId,
    });

    expect(diff.summary).toEqual({ added: 0, modified: 0, deleted: 0 });
    expect(diff.files).toEqual([]);
  });

  it("retries artifact persistence for an existing non-empty patch without an artifact", async () => {
    let failNextWrite = true;
    const storage = createStorage({
      rootDir: await tempDir("ohbaby-snapshot-flaky-storage-"),
      writeFile: async (path, data) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("disk full");
        }
        await writeFile(path, data);
      },
    });
    const service = await createService({ storage });
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-artifact-retry-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const checkpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");

    const failedArtifactPatch = await service.capture({
      checkpointId: checkpoint.checkpointId,
    });
    expect(failedArtifactPatch.fileCount).toBe(1);
    expect(failedArtifactPatch.artifactPath).toBeNull();

    const repairedPatch = await service.capture({
      checkpointId: checkpoint.checkpointId,
    });

    expect(repairedPatch.patchId).toBe(failedArtifactPatch.patchId);
    expect(repairedPatch.artifactPath).toBeTypeOf("string");
  });

  it("lists checkpoints by session with run and turn filters in reverse creation order", async () => {
    const service = await createService();
    insertSession("session_1");
    insertSession("session_2");
    insertRun("session_1", "run_a");
    insertRun("session_1", "run_b");
    const workdir = await tempDir("ohbaby-snapshot-list-");

    await service.track({
      sessionId: "session_1",
      runId: "run_a",
      turnId: "turn_1",
      workdir,
    });
    const second = await service.track({
      sessionId: "session_1",
      runId: "run_b",
      turnId: "turn_2",
      workdir,
    });
    await service.track({
      sessionId: "session_2",
      turnId: "turn_other",
      workdir,
    });

    expect(
      (await service.listCheckpoints("session_1")).map(
        (checkpoint) => checkpoint.turnId,
      ),
    ).toEqual(["turn_2", "turn_1"]);
    expect(
      (await service.listCheckpoints("session_1", { runId: "run_b" })).map(
        (checkpoint) => checkpoint.checkpointId,
      ),
    ).toEqual([second.checkpointId]);
    expect(
      (await service.listCheckpoints("session_1", { turnId: "turn_1" })).map(
        (checkpoint) => checkpoint.turnId,
      ),
    ).toEqual(["turn_1"]);
  });

  it("throws ArtifactNotAvailableError when a non-empty patch loses its artifact", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-missing-artifact-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const checkpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
    const patch = await service.capture({
      checkpointId: checkpoint.checkpointId,
    });

    await service.store.deleteArtifact(patch.patchId);

    await expect(
      service.restore({ checkpointId: checkpoint.checkpointId }),
    ).rejects.toThrow(ArtifactNotAvailableError);
  });

  it("preflights the restore patch chain before changing files", async () => {
    const service = await createService();
    insertSession("session_1");
    const workdir = await tempDir("ohbaby-snapshot-restore-preflight-");
    await writeFile(join(workdir, "file.txt"), "v0\n", "utf8");
    const firstCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_1",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "v1\n", "utf8");
    const firstPatch = await service.capture({
      checkpointId: firstCheckpoint.checkpointId,
    });

    const secondCheckpoint = await service.track({
      sessionId: "session_1",
      turnId: "turn_2",
      workdir,
    });
    await writeFile(join(workdir, "file.txt"), "v2\n", "utf8");
    await service.capture({ checkpointId: secondCheckpoint.checkpointId });
    await service.store.deleteArtifact(firstPatch.patchId);

    await expect(
      service.restore({ checkpointId: firstCheckpoint.checkpointId }),
    ).rejects.toThrow(ArtifactNotAvailableError);
    await expect(readFile(join(workdir, "file.txt"), "utf8")).resolves.toBe(
      "v2\n",
    );
  });
});
