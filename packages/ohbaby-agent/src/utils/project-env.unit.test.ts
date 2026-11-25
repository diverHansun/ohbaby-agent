import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOhbabyHome } from "../paths/index.js";
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
    vi.restoreAllMocks();
    process.env = originalEnv;
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("resolves global and project .env paths", () => {
    expect(getGlobalEnvPath("D:/home")).toBe(
      path.join("D:/home", ".ohbaby", ".env"),
    );
    expect(getProjectEnvPath("D:/repo")).toBe(path.join("D:/repo", ".env"));
  });

  it("loads project env over global env without overriding shell values", async () => {
    const homeDirectory = path.join(tempRoot, "home");
    const repoRoot = path.join(tempRoot, "repo");
    const childDirectory = path.join(repoRoot, "packages", "app");
    await fs.mkdir(path.join(homeDirectory, ".ohbaby"), {
      recursive: true,
    });
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(childDirectory, { recursive: true });
    await fs.writeFile(
      path.join(homeDirectory, ".ohbaby", ".env"),
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
      globalEnvPath: path.join(homeDirectory, ".ohbaby", ".env"),
      projectEnvPath: path.join(repoRoot, ".env"),
      projectRoot: repoRoot,
    });
    expect(process.env.GLOBAL_ONLY).toBe("from-global");
    expect(process.env.PROJECT_ONLY).toBe("from-project");
    expect(process.env.PROJECT_OVERRIDE).toBe("from-project");
    expect(process.env.SHELL_KEY).toBe("from-shell");
  });

  it("leaves earlier profiles untouched when there is no current profile", async () => {
    const homeDirectory = path.join(tempRoot, "home");
    const projectDirectory = path.join(tempRoot, "repo");
    const oldProfile = path.join(homeDirectory, ".ohbaby-agent");
    await fs.mkdir(projectDirectory);
    await fs.mkdir(oldProfile, { recursive: true });
    await fs.writeFile(path.join(oldProfile, ".env"), "OLD_PROFILE_MARK=old");
    await fs.writeFile(path.join(oldProfile, "model.json"), "{}");
    delete process.env.OLD_PROFILE_MARK;

    await loadRuntimeEnvIntoProcessEnv({ homeDirectory, projectDirectory });

    expect(process.env.OLD_PROFILE_MARK).toBeUndefined();
    await expect(
      fs.stat(path.join(homeDirectory, ".ohbaby")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(oldProfile)).sort()).toEqual([
      ".env",
      "model.json",
    ]);
    expect(await fs.readFile(path.join(oldProfile, ".env"), "utf8")).toBe(
      "OLD_PROFILE_MARK=old",
    );
    expect(await fs.readFile(path.join(oldProfile, "model.json"), "utf8")).toBe(
      "{}",
    );
  });

  it.each([
    ["OHBABY_HOME", "HOME", "USERPROFILE"],
    ["ohbaby_home", "home", "userprofile"],
    ["Ohbaby_Home", "Home", "UserProfile"],
  ])(
    "reserves host directory names in project .env (%s, %s, %s)",
    async (...keys) => {
      const projectDirectory = path.join(tempRoot, "repo");
      const globalDirectory = path.join(tempRoot, ".ohbaby");
      const otherDirectory = path.join(tempRoot, "other");
      vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
      for (const key of [
        ...keys,
        "OHBABY_HOME",
        "HOME",
        "USERPROFILE",
        "TrustedMark",
        "OtherMark",
        "OrdinaryKey",
      ]) {
        Reflect.deleteProperty(process.env, key);
      }
      await fs.mkdir(globalDirectory);
      await fs.mkdir(projectDirectory);
      await fs.mkdir(otherDirectory);
      await fs.writeFile(
        path.join(globalDirectory, ".env"),
        "TrustedMark=present",
      );
      await fs.writeFile(
        path.join(otherDirectory, ".env"),
        "OtherMark=present",
      );
      await fs.writeFile(
        path.join(projectDirectory, ".env"),
        [
          ...keys.map((key) => key + "=" + otherDirectory),
          "OrdinaryKey=value",
        ].join("\n"),
      );

      const result = await loadRuntimeEnvIntoProcessEnv({ projectDirectory });
      expect(result.globalEnvPath).toBe(path.join(globalDirectory, ".env"));
      expect(resolveOhbabyHome()).toBe(globalDirectory);
      for (const key of keys) expect(process.env[key]).toBeUndefined();
      expect(process.env.TrustedMark).toBe("present");
      expect(process.env.OtherMark).toBeUndefined();
      expect(process.env.OrdinaryKey).toBe("value");
    },
  );

  it("uses the configuration root supplied by the host", async () => {
    const projectDirectory = path.join(tempRoot, "repo");
    const hostRoot = path.join(tempRoot, "profile");
    process.env.OHBABY_HOME = hostRoot;
    await fs.mkdir(projectDirectory);
    await fs.mkdir(hostRoot);
    await fs.writeFile(
      path.join(projectDirectory, ".env"),
      "OHBABY_HOME=ignored",
    );

    const result = await loadRuntimeEnvIntoProcessEnv({ projectDirectory });
    expect(result.globalEnvPath).toBe(path.join(hostRoot, ".env"));
    expect(process.env.OHBABY_HOME).toBe(hostRoot);
  });
});
