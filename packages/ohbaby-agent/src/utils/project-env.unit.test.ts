import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGlobalEnvPath,
  getProjectEnvPath,
  loadRuntimeEnvIntoProcessEnv,
} from "./project-env.js";

describe("project env loading", () => {
  const originalEnv = process.env;
  let tempRoot: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-env-"));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("resolves global and project .env paths", () => {
    expect(getGlobalEnvPath("D:/home")).toBe(
      path.join("D:/home", ".ohbaby-agent", ".env"),
    );
    expect(getProjectEnvPath("D:/repo")).toBe(path.join("D:/repo", ".env"));
  });

  it("loads project env over global env without overriding shell values", async () => {
    const homeDirectory = path.join(tempRoot, "home");
    const repoRoot = path.join(tempRoot, "repo");
    const childDirectory = path.join(repoRoot, "packages", "app");
    await fs.mkdir(path.join(homeDirectory, ".ohbaby-agent"), {
      recursive: true,
    });
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(childDirectory, { recursive: true });
    await fs.writeFile(
      path.join(homeDirectory, ".ohbaby-agent", ".env"),
      [
        "GLOBAL_ONLY=from-global",
        "PROJECT_OVERRIDE=from-global",
        "SHELL_KEY=from-global",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "PROJECT_ONLY=from-project",
        "PROJECT_OVERRIDE=from-project",
        "SHELL_KEY=from-project",
      ].join("\n"),
    );

    process.env.SHELL_KEY = "from-shell";
    delete process.env.GLOBAL_ONLY;
    delete process.env.PROJECT_ONLY;
    delete process.env.PROJECT_OVERRIDE;

    const result = await loadRuntimeEnvIntoProcessEnv({
      homeDirectory,
      projectDirectory: childDirectory,
    });

    expect(result).toEqual({
      globalEnvPath: path.join(homeDirectory, ".ohbaby-agent", ".env"),
      projectEnvPath: path.join(repoRoot, ".env"),
      projectRoot: repoRoot,
    });
    expect(process.env.GLOBAL_ONLY).toBe("from-global");
    expect(process.env.PROJECT_ONLY).toBe("from-project");
    expect(process.env.PROJECT_OVERRIDE).toBe("from-project");
    expect(process.env.SHELL_KEY).toBe("from-shell");
  });
});
