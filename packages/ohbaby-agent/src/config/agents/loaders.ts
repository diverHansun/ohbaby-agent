import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentConfigAccessError,
  AgentConfigParseError,
  AgentConfigValidationError,
  AgentsConfigSchema,
} from "./types.js";
import type { AgentsConfig } from "./types.js";

export const AGENTS_CONFIG_DIR_NAME = "agents";
export const AGENTS_CONFIG_FILE_NAME = "settings.json";
export const OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent";

const EMPTY_CONFIG: AgentsConfig = { agents: {} };

export interface LoadAgentConfigOptions {
  readonly globalPath?: string;
  readonly projectPath?: string;
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
}

export function getGlobalAgentsConfigPath(
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    OHBABY_CONFIG_DIR_NAME,
    AGENTS_CONFIG_DIR_NAME,
    AGENTS_CONFIG_FILE_NAME,
  );
}

export function getProjectAgentsConfigPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(
    projectDirectory,
    OHBABY_CONFIG_DIR_NAME,
    AGENTS_CONFIG_DIR_NAME,
    AGENTS_CONFIG_FILE_NAME,
  );
}

export function validateAgentsConfig(
  config: unknown,
  sourcePath: string,
): AgentsConfig {
  const result = AgentsConfigSchema.safeParse(config);
  if (!result.success) {
    throw new AgentConfigValidationError(sourcePath, result.error.issues);
  }
  return result.data;
}

export async function loadAgentsConfigFromPath(
  configPath: string,
): Promise<AgentsConfig> {
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_CONFIG;
    }
    throw new AgentConfigAccessError(configPath, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new AgentConfigParseError(configPath, error);
  }

  return validateAgentsConfig(parsed, configPath);
}

export function mergeAgentConfigs(
  globalConfig: AgentsConfig,
  projectConfig: AgentsConfig,
): AgentsConfig {
  return {
    agents: {
      ...globalConfig.agents,
      ...projectConfig.agents,
    },
  };
}

export async function loadAgentConfig(
  options: LoadAgentConfigOptions = {},
): Promise<AgentsConfig> {
  const globalPath =
    options.globalPath ?? getGlobalAgentsConfigPath(options.homeDirectory);
  const projectPath =
    options.projectPath ?? getProjectAgentsConfigPath(options.projectDirectory);
  const [globalConfig, projectConfig] = await Promise.all([
    loadAgentsConfigFromPath(globalPath),
    loadAgentsConfigFromPath(projectPath),
  ]);

  return mergeAgentConfigs(globalConfig, projectConfig);
}
