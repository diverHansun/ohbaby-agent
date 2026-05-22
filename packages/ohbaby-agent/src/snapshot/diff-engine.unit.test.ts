import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidSnapshotArtifactError,
  ShadowDiffEngine,
  parsePatchArtifact,
  serializePatchArtifact,
} from "./index.js";
import type { SnapshotCheckpoint, SnapshotPatchArtifact } from "./types.js";

const cleanupPaths: string[] = [];

async function tempWorkdir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-diff-engine-"));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function checkpoint(workdir: string): SnapshotCheckpoint {
  return {
    checkpointId: "checkpoint_1",
    sessionId: "session_1",
    turnId: "turn_1",
    workdir,
    createdAt: 1,
  };
}

describe("ShadowDiffEngine", () => {
  it("computes a shadow diff and restores the baseline content", async () => {
    const workdir = await tempWorkdir();
    await writeFile(join(workdir, "file.txt"), "before", "utf8");
    const engine = new ShadowDiffEngine();
    const tracked = checkpoint(workdir);
    await engine.recordBaseline(tracked.checkpointId, workdir);

    await writeFile(join(workdir, "file.txt"), "after", "utf8");
    const computed = await engine.computeDiff(tracked);

    expect(computed.summary).toEqual({ added: 0, modified: 1, deleted: 0 });
    const artifact: SnapshotPatchArtifact = {
      version: 1,
      checkpointId: tracked.checkpointId,
      patchId: "patch_1",
      createdAt: 2,
      files: computed.filePatches,
    };
    await engine.applyReverse(workdir, artifact);

    await expect(readFile(join(workdir, "file.txt"), "utf8")).resolves.toBe(
      "before",
    );
  });

  it("round-trips snapshot patch artifacts as JSON", () => {
    const artifact: SnapshotPatchArtifact = {
      version: 1,
      checkpointId: "checkpoint_1",
      patchId: "patch_1",
      createdAt: 2,
      files: [{ path: "new.txt", status: "added", afterContentBase64: "bmV3" }],
    };

    expect(parsePatchArtifact(serializePatchArtifact(artifact))).toEqual(
      artifact,
    );
  });

  it("rejects artifact paths that escape the workdir", async () => {
    const workdir = await tempWorkdir();
    const engine = new ShadowDiffEngine();

    await expect(
      engine.applyReverse(workdir, {
        version: 1,
        checkpointId: "checkpoint_1",
        patchId: "patch_1",
        createdAt: 1,
        files: [
          {
            path: "../escape.txt",
            status: "modified",
            beforeContentBase64: "YmFk",
          },
        ],
      }),
    ).rejects.toThrow(InvalidSnapshotArtifactError);
  });
});
