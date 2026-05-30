import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitSnapshotEngine } from "./index.js";
import type { SnapshotCheckpoint } from "./types.js";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function gitdirFor(snapshotRoot: string, workdir: string): string {
  const hash = createHash("sha1")
    .update(resolve(workdir))
    .digest("hex")
    .slice(0, 16);
  return join(snapshotRoot, "snapshot-git", hash);
}

async function git(
  snapshotRoot: string,
  workdir: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "--git-dir",
    gitdirFor(snapshotRoot, workdir),
    "--work-tree",
    workdir,
    ...args,
  ]);
  return stdout.trim();
}

async function gitSucceeds(
  snapshotRoot: string,
  workdir: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await git(snapshotRoot, workdir, args);
    return true;
  } catch {
    return false;
  }
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

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitSnapshotEngine", () => {
  it("creates sibling pre and post refs without git ref collision", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });

    const pre = await engine.recordBaseline("checkpoint_1", workdir);
    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
    const computed = await engine.computeDiff(checkpoint(workdir, pre));

    await expect(
      git(snapshotRoot, workdir, [
        "rev-parse",
        "refs/snapshots/checkpoint_1/pre",
      ]),
    ).resolves.toBe(pre);
    await expect(
      git(snapshotRoot, workdir, [
        "rev-parse",
        "refs/snapshots/checkpoint_1/post",
      ]),
    ).resolves.toBe(computed.commit);
  });

  it("uses a fixed commit identity when global git identity is unavailable", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    const home = await tempDir("ohbaby-empty-home-");
    await writeFile(join(workdir, "file.txt"), "content\n", "utf8");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const engine = new GitSnapshotEngine({ snapshotRoot });
      await expect(
        engine.recordBaseline("checkpoint_1", workdir),
      ).resolves.toMatch(/^[0-9a-f]{40,64}$/);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });

  it("computes added modified and deleted file diffs", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "modified.txt"), "before\n", "utf8");
    await writeFile(join(workdir, "deleted.txt"), "delete me\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    const pre = await engine.recordBaseline("checkpoint_1", workdir);

    await writeFile(join(workdir, "modified.txt"), "after\n", "utf8");
    await writeFile(join(workdir, "added.txt"), "new\n", "utf8");
    await rm(join(workdir, "deleted.txt"));

    const computed = await engine.computeDiff(checkpoint(workdir, pre));

    expect(computed.summary).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(
      computed.files.map((file) => [file.path, file.status]).sort(),
    ).toEqual([
      ["added.txt", "added"],
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
    ]);
  });

  it("respects .gitignore for untracked ignored files", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, ".gitignore"), "build/\n", "utf8");
    await mkdir(join(workdir, "build"));
    await writeFile(join(workdir, "build", "out.txt"), "ignored\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    const pre = await engine.recordBaseline("checkpoint_1", workdir);

    await writeFile(join(workdir, "build", "out.txt"), "changed\n", "utf8");
    const computed = await engine.computeDiff(checkpoint(workdir, pre));

    expect(computed.files).toEqual([]);
  });

  it("restores tracked files and deletes tracked files added after the checkpoint", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    const pre = await engine.recordBaseline("checkpoint_1", workdir);

    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
    await writeFile(join(workdir, "tracked-new.txt"), "new\n", "utf8");
    await engine.computeDiff(checkpoint(workdir, pre));
    await engine.restoreTo(workdir, pre);

    await expect(readFile(join(workdir, "file.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(
      readFile(join(workdir, "tracked-new.txt"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("leaves ignored untracked files alone during restore", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    const pre = await engine.recordBaseline("checkpoint_1", workdir);

    await writeFile(join(workdir, "ignored.txt"), "keep me\n", "utf8");
    await engine.restoreTo(workdir, pre);

    await expect(readFile(join(workdir, "ignored.txt"), "utf8")).resolves.toBe(
      "keep me\n",
    );
  });

  it("diffWorkingTree does not create a post ref", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    const pre = await engine.recordBaseline("checkpoint_1", workdir);

    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
    const files = await engine.diffWorkingTree(checkpoint(workdir, pre));

    expect(files).toEqual([{ path: "file.txt", status: "modified" }]);
    await expect(
      gitSucceeds(snapshotRoot, workdir, [
        "rev-parse",
        "refs/snapshots/checkpoint_1/post",
      ]),
    ).resolves.toBe(false);
  });

  it("does not leave a post ref when diff computation fails", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    await engine.recordBaseline("checkpoint_1", workdir);

    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
    await expect(
      engine.computeDiff(checkpoint(workdir, "missing-baseline-commit")),
    ).rejects.toThrow();

    await expect(
      gitSucceeds(snapshotRoot, workdir, [
        "rev-parse",
        "refs/snapshots/checkpoint_1/post",
      ]),
    ).resolves.toBe(false);
  });

  it("drops refs and allows gc now to prune deleted checkpoint commits", async () => {
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    await writeFile(join(workdir, "file.txt"), "before\n", "utf8");
    const engine = new GitSnapshotEngine({ snapshotRoot });
    const pre = await engine.recordBaseline("checkpoint_1", workdir);
    await writeFile(join(workdir, "file.txt"), "after\n", "utf8");
    const post = (await engine.computeDiff(checkpoint(workdir, pre))).commit;

    await engine.dropRef("checkpoint_1", workdir);
    await engine.gc(workdir, "now");

    await expect(
      gitSucceeds(snapshotRoot, workdir, ["cat-file", "-e", pre]),
    ).resolves.toBe(false);
    await expect(
      gitSucceeds(snapshotRoot, workdir, ["cat-file", "-e", post]),
    ).resolves.toBe(false);
  });
});
