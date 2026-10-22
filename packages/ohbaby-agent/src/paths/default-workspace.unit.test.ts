import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectEnvironment } from "../core/system-prompt/layers/environment.js";
import { getProjectRoot } from "../project/project-manager.js";
import {
  defaultWorkspaceBoundary,
  ensureDefaultWorkspaceDirectory,
  isDefaultWorkspaceDirectory,
  resolveDefaultWorkspaceDirectory,
} from "./default-workspace.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ohbaby-default-workspace-"));
  vi.stubEnv("OHBABY_HOME", join(home, ".ohbaby"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("default workspace", () => {
  it("follows OHBABY_HOME", () => {
    expect(resolveDefaultWorkspaceDirectory()).toBe(
      join(home, ".ohbaby", "workspace", "default"),
    );
  });

  it("creates the directory once with private permissions on POSIX", async () => {
    const created = await ensureDefaultWorkspaceDirectory();
    expect(created).toBe(await realpath(resolveDefaultWorkspaceDirectory()));
    const createdStat = await stat(created);
    expect(createdStat.isDirectory()).toBe(true);
    // Windows does not expose POSIX directory permission bits.
    if (process.platform !== "win32") {
      expect(createdStat.mode & 0o777).toBe(0o700);
    }
    await expect(ensureDefaultWorkspaceDirectory()).resolves.toBe(created);
  });

  it("keeps existing contents and permissions", async () => {
    const directory = resolveDefaultWorkspaceDirectory();
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const originalMode = (await stat(directory)).mode & 0o777;
    await writeFile(join(directory, "notes.md"), "keep");

    await ensureDefaultWorkspaceDirectory();

    expect((await stat(directory)).mode & 0o777).toBe(originalMode);
    expect(await readFile(join(directory, "notes.md"), "utf8")).toBe("keep");
  });

  it("is never absorbed by a Git repository in a parent directory", async () => {
    await mkdir(join(home, ".git"));
    const directory = await ensureDefaultWorkspaceDirectory();
    await mkdir(join(directory, "nested"));

    await expect(getProjectRoot(directory)).resolves.toBeNull();
    await expect(getProjectRoot(join(directory, "nested"))).resolves.toBeNull();
    await expect(detectEnvironment(directory)).resolves.toMatchObject({
      isGitRepo: false,
    });
    // An unrelated directory under the same parent still finds the repository.
    await mkdir(join(home, "project"));
    await expect(getProjectRoot(join(home, "project"))).resolves.toBe(home);
  });

  it("reports a repository created inside the default workspace", async () => {
    const directory = await ensureDefaultWorkspaceDirectory();
    await mkdir(join(directory, ".git"));

    await expect(getProjectRoot(directory)).resolves.toBe(directory);
    await expect(detectEnvironment(directory)).resolves.toMatchObject({
      isGitRepo: true,
    });
  });

  it("identifies the directory and its children", async () => {
    const directory = await ensureDefaultWorkspaceDirectory();
    expect(isDefaultWorkspaceDirectory(directory)).toBe(true);
    expect(isDefaultWorkspaceDirectory(join(directory, "child"))).toBe(false);
    expect(defaultWorkspaceBoundary(join(directory, "child"))).toBe(directory);
    expect(defaultWorkspaceBoundary(home)).toBeUndefined();
  });
});
