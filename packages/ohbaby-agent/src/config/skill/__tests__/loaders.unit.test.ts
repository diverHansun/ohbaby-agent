import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SkillConfigAccessError,
  SkillConfigParseError,
  SkillConfigValidationError,
} from "../types.js";
import {
  PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY,
  getGlobalSkillConfigPath,
  getProjectSkillConfigPath,
  loadSkillConfig,
  loadSkillConfigLenient,
  loadSkillConfigFromPath,
  mergeSkillConfigs,
} from "../loaders.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

describe("config/skill loaders", () => {
  let tempDir: string;
  let globalPath: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-skill-config-"));
    globalPath = path.join(
      tempDir,
      "home",
      ".ohbaby-agent",
      "skills",
      "settings.json",
    );
    projectPath = path.join(
      tempDir,
      "repo",
      ".ohbaby-agent",
      "skills",
      "settings.json",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves default global and project settings.json paths", () => {
    expect(getGlobalSkillConfigPath("D:/home")).toBe(
      path.join("D:/home", ".ohbaby-agent", "skills", "settings.json"),
    );
    expect(getProjectSkillConfigPath("D:/repo")).toBe(
      path.join("D:/repo", ".ohbaby-agent", "skills", "settings.json"),
    );
  });

  it("returns empty config when settings files do not exist", async () => {
    await expect(loadSkillConfigFromPath(globalPath)).resolves.toEqual({
      directories: [],
    });
    await expect(loadSkillConfig({ globalPath, projectPath })).resolves.toEqual(
      {
        directories: [],
      },
    );
  });

  it("loads and merges global and project directories in order", async () => {
    const globalSkillPath = path.join(tempDir, "global", "native-skills");
    const projectSkillPath = path.join(tempDir, "repo", ".claude", "skills");
    await writeJson(globalPath, {
      directories: [
        {
          path: globalSkillPath,
          priority: 41,
          scope: "user",
          source: "user-native",
        },
      ],
    });
    await writeJson(projectPath, {
      directories: [
        {
          path: projectSkillPath,
          scope: "project",
          source: "claude-compatible",
        },
      ],
    });

    await expect(loadSkillConfig({ globalPath, projectPath })).resolves.toEqual(
      {
        directories: [
          {
            path: path.normalize(globalSkillPath),
            priority: 41,
            scope: "user",
            source: "user-native",
          },
          {
            path: path.normalize(projectSkillPath),
            priority: PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY,
            scope: "project",
            source: "claude-compatible",
          },
        ],
      },
    );
  });

  it("resolves relative directory paths from the settings file directory", async () => {
    await writeJson(projectPath, {
      directories: [
        {
          path: "configured-skills",
          scope: "project",
        },
      ],
    });

    await expect(loadSkillConfigFromPath(projectPath)).resolves.toEqual({
      directories: [
        {
          path: path.join(path.dirname(projectPath), "configured-skills"),
          scope: "project",
        },
      ],
    });
  });

  it("loads settings files written with a UTF-8 BOM", async () => {
    const skillPath = path.join(tempDir, "skills");
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(
      globalPath,
      `\uFEFF${JSON.stringify({
        directories: [
          {
            path: skillPath,
            scope: "user",
          },
        ],
      })}`,
      "utf8",
    );

    await expect(loadSkillConfigFromPath(globalPath)).resolves.toEqual({
      directories: [
        {
          path: path.normalize(skillPath),
          scope: "user",
        },
      ],
    });
  });

  it("exposes append merge as a pure helper", () => {
    expect(
      mergeSkillConfigs(
        {
          directories: [
            {
              path: "D:/global",
              scope: "user",
            },
          ],
        },
        {
          directories: [
            {
              path: "D:/project",
              scope: "project",
            },
          ],
        },
      ),
    ).toEqual({
      directories: [
        {
          path: "D:/global",
          scope: "user",
        },
        {
          path: "D:/project",
          scope: "project",
        },
      ],
    });
  });

  it("throws SkillConfigParseError for malformed JSON", async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, "{ invalid json", "utf8");

    await expect(loadSkillConfig({ globalPath, projectPath })).rejects.toThrow(
      SkillConfigParseError,
    );
    await expect(
      loadSkillConfig({ globalPath, projectPath }),
    ).rejects.toMatchObject({ path: globalPath });
  });

  it("throws SkillConfigValidationError with source path for schema failures", async () => {
    await writeJson(projectPath, {
      directories: [
        {
          path: "",
          scope: "project",
        },
      ],
    });

    await expect(loadSkillConfig({ globalPath, projectPath })).rejects.toThrow(
      SkillConfigValidationError,
    );
    await expect(
      loadSkillConfig({ globalPath, projectPath }),
    ).rejects.toMatchObject({ path: projectPath });
  });

  it("throws SkillConfigAccessError for unreadable settings paths", async () => {
    await fs.mkdir(globalPath, { recursive: true });

    await expect(loadSkillConfig({ globalPath, projectPath })).rejects.toThrow(
      SkillConfigAccessError,
    );
  });

  it("loads remaining valid settings when another settings file is invalid", async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, "{ invalid json", "utf8");
    await writeJson(projectPath, {
      directories: [
        {
          path: "configured-skills",
          scope: "project",
        },
      ],
    });
    const warnings: string[] = [];

    await expect(
      loadSkillConfigLenient({
        globalPath,
        onWarning(error) {
          warnings.push(error.path ?? "");
        },
        projectPath,
      }),
    ).resolves.toEqual({
      directories: [
        {
          path: path.join(path.dirname(projectPath), "configured-skills"),
          priority: PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY,
          scope: "project",
        },
      ],
    });
    expect(warnings).toEqual([globalPath]);
  });
});
