import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Project } from "./index.js";

const execFileAsync = promisify(execFile);

let tempRoot: string;

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    timeout: 10_000,
  });
  return stdout.trim();
}

async function createGitRepo(name: string): Promise<string> {
  const repo = path.join(tempRoot, name);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init"]);
  await runGit(repo, [
    "-c",
    "user.name=Ohbaby Test",
    "-c",
    "user.email=ohbaby@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  return repo;
}

async function getRootCommit(repo: string): Promise<string> {
  const roots = await runGit(repo, ["rev-list", "--max-parents=0", "--all"]);
  return roots.split(/\r?\n/u).filter(Boolean).sort()[0];
}

describe("Project", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-project-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("returns a global project for non-git directories", async () => {
    const directory = path.join(tempRoot, "plain");
    await fs.mkdir(directory);

    await expect(Project.fromDirectory(directory)).resolves.toEqual({
      id: "global",
      rootPath: path.resolve(directory),
    });
    await expect(Project.getProjectRoot(directory)).resolves.toBeNull();
    await expect(Project.isGitProject(directory)).resolves.toBe(false);
  });

  it("returns a stable git project id and root from child directories", async () => {
    const repo = await createGitRepo("repo");
    const child = path.join(repo, "src", "feature");
    await fs.mkdir(child, { recursive: true });
    const rootCommit = await getRootCommit(repo);

    await expect(Project.fromDirectory(child)).resolves.toEqual({
      id: rootCommit,
      rootPath: path.resolve(repo),
      vcs: "git",
    });
    await expect(Project.getProjectRoot(child)).resolves.toBe(
      path.resolve(repo),
    );
    await expect(Project.isGitProject(child)).resolves.toBe(true);
  });

  it("falls back to global when a git repository has no commits", async () => {
    const repo = path.join(tempRoot, "empty-repo");
    await fs.mkdir(repo);
    await runGit(repo, ["init"]);

    await expect(Project.fromDirectory(repo)).resolves.toEqual({
      id: "global",
      rootPath: path.resolve(repo),
    });
  });

  it("falls back to global when the start directory is missing", async () => {
    const missing = path.join(tempRoot, "missing");

    await expect(Project.fromDirectory(missing)).resolves.toEqual({
      id: "global",
      rootPath: path.resolve(missing),
    });
    await expect(Project.getProjectRoot(missing)).resolves.toBeNull();
  });

  it("treats a .git file as a git project boundary", async () => {
    const worktreeLike = path.join(tempRoot, "worktree-like");
    const child = path.join(worktreeLike, "src");
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(
      path.join(worktreeLike, ".git"),
      "gitdir: ../repo/.git/worktrees/worktree-like\n",
      "utf8",
    );

    await expect(Project.getProjectRoot(child)).resolves.toBe(
      path.resolve(worktreeLike),
    );
    await expect(Project.isGitProject(child)).resolves.toBe(true);
  });
});
