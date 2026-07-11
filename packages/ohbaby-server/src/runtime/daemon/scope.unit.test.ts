import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDaemonScope } from "./scope.js";

describe("resolveDaemonScope", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs
        .splice(0)
        .map((dir) => rm(dir, { force: true, recursive: true })),
    );
  });

  it("uses one user-level server registry while retaining the git root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-scope-git-"));
    cleanupDirs.push(root);
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "packages", "app"), { recursive: true });
    const canonicalRoot = await realpath(root);

    const scope = await resolveDaemonScope({
      homeDirectory: root,
      workdir: join(root, "packages", "app"),
    });

    expect(scope.scopeRoot).toBe(canonicalRoot);
    expect(scope.pidFilePath).toBe(
      join(canonicalRoot, ".ohbaby", "server", "daemon.pid"),
    );
    expect(scope.stateFilePath).toBe(
      join(canonicalRoot, ".ohbaby", "server", "daemon-state.json"),
    );
    expect(scope.legacyPidFilePath).toBe(
      join(canonicalRoot, ".ohbaby", "server", "daemon.pid"),
    );
  });

  it("uses the resolved cwd when no git root exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-scope-plain-"));
    cleanupDirs.push(root);
    const canonicalRoot = await realpath(root);

    const scope = await resolveDaemonScope({
      homeDirectory: root,
      workdir: root,
    });

    expect(scope.scopeRoot).toBe(canonicalRoot);
    expect(scope.stateFilePath).toBe(
      join(canonicalRoot, ".ohbaby", "server", "daemon-state.json"),
    );
    expect(scope.legacyStateFilePath).toBe(
      join(canonicalRoot, ".ohbaby", "server", "daemon-state.json"),
    );
  });
});
