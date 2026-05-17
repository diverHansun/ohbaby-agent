import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentConfigAccessError,
  AgentConfigParseError,
  AgentConfigValidationError,
  AgentConfigSchema,
} from "../types.js";
import {
  getGlobalAgentsConfigPath,
  getProjectAgentsConfigPath,
  loadAgentConfig,
  loadAgentsConfigFromPath,
  mergeAgentConfigs,
} from "../loaders.js";

function agent(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    mode: "primary",
    description: `${name} agent`,
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

describe("config/agents loaders", () => {
  let tempDir: string;
  let globalPath: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-agents-"));
    globalPath = path.join(tempDir, "home", ".ohbaby-agent", "agents", "settings.json");
    projectPath = path.join(
      tempDir,
      "repo",
      ".ohbaby-agent",
      "agents",
      "settings.json",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves default global and project settings.json paths", () => {
    expect(getGlobalAgentsConfigPath("D:/home")).toBe(
      path.join("D:/home", ".ohbaby-agent", "agents", "settings.json"),
    );
    expect(getProjectAgentsConfigPath("D:/repo")).toBe(
      path.join("D:/repo", ".ohbaby-agent", "agents", "settings.json"),
    );
  });

  it("returns empty config when a settings file does not exist", async () => {
    await expect(loadAgentsConfigFromPath(globalPath)).resolves.toEqual({
      agents: {},
    });
    await expect(
      loadAgentConfig({ globalPath, projectPath }),
    ).resolves.toEqual({ agents: {} });
  });

  it("loads only global config when project config is missing", async () => {
    await writeJson(globalPath, {
      agents: {
        build: agent("build", { maxSteps: 50 }),
      },
    });

    const config = await loadAgentConfig({ globalPath, projectPath });

    expect(config.agents.build.maxSteps).toBe(50);
  });

  it("loads only project config when global config is missing", async () => {
    await writeJson(projectPath, {
      agents: {
        review: agent("review", { temperature: 0.3 }),
      },
    });

    const config = await loadAgentConfig({ globalPath, projectPath });

    expect(config.agents.review.temperature).toBe(0.3);
  });

  it("merges different names and fully replaces same-name project agents", async () => {
    await writeJson(globalPath, {
      agents: {
        explore: agent("explore", {
          mode: "subagent",
          description: "Global explorer",
          maxSteps: 15,
          temperature: 0.5,
        }),
        security: agent("security", { maxSteps: 20 }),
      },
    });
    await writeJson(projectPath, {
      agents: {
        explore: agent("explore", {
          mode: "subagent",
          description: "Project explorer",
          maxSteps: 25,
        }),
      },
    });

    const config = await loadAgentConfig({ globalPath, projectPath });

    expect(Object.keys(config.agents).sort()).toEqual(["explore", "security"]);
    expect(config.agents.explore).toMatchObject({
      description: "Project explorer",
      maxSteps: 25,
    });
    expect(config.agents.explore.temperature).toBeUndefined();
  });

  it("exposes full replacement merge as a pure helper", () => {
    expect(
      mergeAgentConfigs(
        {
          agents: {
            build: AgentConfigSchema.parse(agent("build", { maxSteps: 50 })),
          },
        },
        {
          agents: {
            build: AgentConfigSchema.parse(agent("build", { maxSteps: 30 })),
          },
        },
      ).agents.build,
    ).toMatchObject({ maxSteps: 30 });
  });

  it("throws AgentConfigParseError for malformed JSON", async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, "{ invalid json", "utf8");

    await expect(loadAgentConfig({ globalPath, projectPath })).rejects.toThrow(
      AgentConfigParseError,
    );
    await expect(loadAgentConfig({ globalPath, projectPath })).rejects.toMatchObject({
      path: globalPath,
    });
  });

  it("throws AgentConfigValidationError with source path for schema failures", async () => {
    await writeJson(projectPath, {
      agents: {
        explore: {
          name: "explore",
          mode: "subagent",
        },
      },
    });

    await expect(loadAgentConfig({ globalPath, projectPath })).rejects.toThrow(
      AgentConfigValidationError,
    );
    await expect(loadAgentConfig({ globalPath, projectPath })).rejects.toMatchObject({
      path: projectPath,
    });
  });

  it("throws AgentConfigAccessError for unreadable settings paths", async () => {
    await fs.mkdir(globalPath, { recursive: true });

    await expect(loadAgentConfig({ globalPath, projectPath })).rejects.toThrow(
      AgentConfigAccessError,
    );
  });
});
