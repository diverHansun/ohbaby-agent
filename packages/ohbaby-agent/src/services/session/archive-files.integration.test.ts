import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { GitSnapshotEngine } from "../../snapshot/diff-engine.js";
import { cleanupDeletedSessionFiles } from "./archive-files.js";
const exec = promisify(execFile);
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it("drops only deleted refs after the workdir is gone and cleans every descendant's result files", async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-archive-files-"));
  const workdir = join(root, "work");
  vi.stubEnv("OHBABY_HOME", root);
  const storage = join(root, "sessions");
  await mkdir(workdir);
  await writeFile(join(workdir, "file"), "before");
  const engine = new GitSnapshotEngine({ snapshotRoot: root });
  const preTreeRef = await engine.recordBaseline("deleted", workdir);
  await writeFile(join(workdir, "file"), "after");
  await engine.computeDiff({
    checkpointId: "deleted",
    sessionId: "root",
    turnId: "turn",
    workdir,
    preTreeRef,
    createdAt: 1,
  });
  await engine.recordBaseline("keep", workdir);
  for (const id of ["root", "child", "grandchild", "keep"]) {
    await mkdir(join(storage, id, "subagents"), { recursive: true });
    await writeFile(join(storage, id, "subagents", "result"), "result");
  }
  await rm(workdir, { recursive: true });
  const log = vi.fn();
  await cleanupDeletedSessionFiles(
    {
      sessionIds: ["root", "child", "grandchild"],
      checkpoints: [{ checkpointId: "deleted", workdir }],
    },
    { snapshotRoot: root, log },
  );
  const gitdir = join(
    root,
    "snapshot-git",
    createHash("sha1").update(resolve(workdir)).digest("hex").slice(0, 16),
  );
  const refs = await exec("git", [
    "--git-dir",
    gitdir,
    "for-each-ref",
    "--format=%(refname)",
  ]);
  expect(refs.stdout.trim()).toBe("refs/snapshots/keep/pre");
  for (const id of ["root", "child", "grandchild"])
    await expect(
      readFile(join(storage, id, "subagents", "result")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(join(storage, "keep", "subagents", "result"), "utf8"),
  ).toBe("result");
  expect(log).not.toHaveBeenCalled();
});
it("logs cleanup failures and still attempts later files, rejecting unsafe storage IDs", async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-archive-failure-"));
  vi.stubEnv("OHBABY_HOME", root);
  await mkdir(join(root, "sessions", "child"), { recursive: true });
  await writeFile(join(root, "sentinel"), "keep");
  const drop = vi
    .spyOn(GitSnapshotEngine.prototype, "dropRef")
    .mockRejectedValue(new Error("injected"));
  const log = vi.fn();
  await expect(
    cleanupDeletedSessionFiles(
      {
        sessionIds: ["..", "child"],
        checkpoints: [{ checkpointId: "cp", workdir: "/gone" }],
      },
      { snapshotRoot: root, log },
    ),
  ).resolves.toBeUndefined();
  expect(drop).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(2);
  expect(await readFile(join(root, "sentinel"), "utf8")).toBe("keep");
  await expect(readFile(join(root, "sessions", "child"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});
