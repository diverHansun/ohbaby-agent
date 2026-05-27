import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  McpConfigAccessError,
  McpConfigParseError,
  McpConfigValidationError,
  McpServersConfigSchema,
} from "./types.js";
import type { McpServersConfig } from "./types.js";

export const MCP_CONFIG_DIR_NAME = "mcp";
export const MCP_CONFIG_FILE_NAME = "settings.json";
export const OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent";

const EMPTY_CONFIG: McpServersConfig = { mcpServers: {} };
const UTF8_BOM = "\uFEFF";

export interface LoadMcpConfigOptions {
  readonly globalPath?: string;
  readonly projectPath?: string;
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
}

export function getGlobalMcpConfigPath(homeDirectory = os.homedir()): string {
  return path.join(
    homeDirectory,
    OHBABY_CONFIG_DIR_NAME,
    MCP_CONFIG_DIR_NAME,
    MCP_CONFIG_FILE_NAME,
  );
}

export function getProjectMcpConfigPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(
    projectDirectory,
    OHBABY_CONFIG_DIR_NAME,
    MCP_CONFIG_DIR_NAME,
    MCP_CONFIG_FILE_NAME,
  );
}

export function validateMcpConfig(
  config: unknown,
  sourcePath: string,
): McpServersConfig {
  const result = McpServersConfigSchema.safeParse(config);
  if (!result.success) {
    throw new McpConfigValidationError(sourcePath, result.error.issues);
  }
  return result.data;
}

export async function loadMcpConfigFromPath(
  configPath: string,
): Promise<McpServersConfig> {
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_CONFIG;
    }
    throw new McpConfigAccessError(configPath, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      content.startsWith(UTF8_BOM) ? content.slice(1) : content,
    );
  } catch (error) {
    throw new McpConfigParseError(configPath, error);
  }

  return validateMcpConfig(parsed, configPath);
}

export function mergeMcpConfigs(
  globalConfig: McpServersConfig,
  projectConfig: McpServersConfig,
): McpServersConfig {
  return {
    mcpServers: {
      ...globalConfig.mcpServers,
      ...projectConfig.mcpServers,
    },
  };
}

export async function loadMcpConfig(
  options: LoadMcpConfigOptions = {},
): Promise<McpServersConfig> {
  const globalPath =
    options.globalPath ?? getGlobalMcpConfigPath(options.homeDirectory);
  const projectPath =
    options.projectPath ?? getProjectMcpConfigPath(options.projectDirectory);
  const [globalConfig, projectConfig] = await Promise.all([
    loadMcpConfigFromPath(globalPath),
    loadMcpConfigFromPath(projectPath),
  ]);

  return mergeMcpConfigs(globalConfig, projectConfig);
}
