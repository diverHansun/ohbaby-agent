import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  McpConfigAccessError,
  McpConfigParseError,
  McpConfigValidationError,
  McpServerConfigSchema,
} from "../types.js";
import {
  getGlobalMcpConfigPath,
  getProjectMcpConfigPath,
  loadMcpConfig,
  loadMcpConfigFromPath,
  mergeMcpConfigs,
} from "../loaders.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

describe("config/mcp loaders", () => {
  let tempDir: string;
  let globalPath: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-mcp-"));
    globalPath = path.join(
      tempDir,
      "home",
      ".ohbaby-agent",
      "mcp",
      "settings.json",
    );
    projectPath = path.join(
      tempDir,
      "repo",
      ".ohbaby-agent",
      "mcp",
      "settings.json",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves default global and project settings.json paths", () => {
    expect(getGlobalMcpConfigPath("D:/home")).toBe(
      path.join("D:/home", ".ohbaby-agent", "mcp", "settings.json"),
    );
    expect(getProjectMcpConfigPath("D:/repo")).toBe(
      path.join("D:/repo", ".ohbaby-agent", "mcp", "settings.json"),
    );
  });

  it("returns empty config when settings files do not exist", async () => {
    await expect(loadMcpConfigFromPath(globalPath)).resolves.toEqual({
      mcpServers: {},
    });
    await expect(loadMcpConfig({ globalPath, projectPath })).resolves.toEqual({
      mcpServers: {},
    });
  });

  it("loads and merges global and project config with project replacement", async () => {
    await writeJson(globalPath, {
      mcpServers: {
        shared: {
          command: "npx",
          args: ["-y", "global-server"],
          trust: false,
        },
        globalOnly: {
          type: "http",
          url: "https://global.example.com/mcp",
        },
      },
    });
    await writeJson(projectPath, {
      mcpServers: {
        shared: {
          command: "node",
          args: ["project-server.js"],
          trust: true,
        },
        projectOnly: {
          type: "sse",
          url: "https://project.example.com/events",
        },
      },
    });

    const config = await loadMcpConfig({ globalPath, projectPath });

    expect(Object.keys(config.mcpServers).sort()).toEqual([
      "globalOnly",
      "projectOnly",
      "shared",
    ]);
    expect(config.mcpServers.shared).toMatchObject({
      args: ["project-server.js"],
      command: "node",
      trust: true,
      type: "stdio",
    });
    expect("global-server" in config.mcpServers.shared).toBe(false);
  });

  it("exposes full replacement merge as a pure helper", () => {
    const globalShared = McpServerConfigSchema.parse({
      command: "npx",
      args: ["global"],
    });
    const projectShared = McpServerConfigSchema.parse({
      command: "node",
      args: ["project.js"],
    });

    expect(
      mergeMcpConfigs(
        { mcpServers: { shared: globalShared } },
        { mcpServers: { shared: projectShared } },
      ).mcpServers.shared,
    ).toMatchObject({ args: ["project.js"], command: "node" });
  });

  it("throws McpConfigParseError for malformed JSON", async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, "{ invalid json", "utf8");

    await expect(loadMcpConfig({ globalPath, projectPath })).rejects.toThrow(
      McpConfigParseError,
    );
    await expect(
      loadMcpConfig({ globalPath, projectPath }),
    ).rejects.toMatchObject({ path: globalPath });
  });

  it("throws McpConfigValidationError with source path for schema failures", async () => {
    await writeJson(projectPath, {
      mcpServers: {
        broken: {
          type: "http",
          url: "not-a-url",
        },
      },
    });

    await expect(loadMcpConfig({ globalPath, projectPath })).rejects.toThrow(
      McpConfigValidationError,
    );
    await expect(
      loadMcpConfig({ globalPath, projectPath }),
    ).rejects.toMatchObject({ path: projectPath });
  });

  it("throws McpConfigAccessError for unreadable settings paths", async () => {
    await fs.mkdir(globalPath, { recursive: true });

    await expect(loadMcpConfig({ globalPath, projectPath })).rejects.toThrow(
      McpConfigAccessError,
    );
  });
});
