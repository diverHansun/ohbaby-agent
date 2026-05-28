import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SkillConfigAccessError,
  SkillConfigParseError,
  SkillConfigSchema,
  SkillConfigValidationError,
} from "./types.js";
import type { SkillConfig } from "./types.js";

export const OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent";
export const SKILL_CONFIG_DIR_NAME = "skills";
export const SKILL_CONFIG_FILE_NAME = "settings.json";

const EMPTY_CONFIG: SkillConfig = { directories: [] };
const UTF8_BOM = "\uFEFF";

export interface LoadSkillConfigOptions {
  readonly globalPath?: string;
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
  readonly projectPath?: string;
}

export function getGlobalSkillConfigPath(
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    OHBABY_CONFIG_DIR_NAME,
    SKILL_CONFIG_DIR_NAME,
    SKILL_CONFIG_FILE_NAME,
  );
}

export function getProjectSkillConfigPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(
    projectDirectory,
    OHBABY_CONFIG_DIR_NAME,
    SKILL_CONFIG_DIR_NAME,
    SKILL_CONFIG_FILE_NAME,
  );
}

export function validateSkillConfig(
  config: unknown,
  sourcePath: string,
): SkillConfig {
  const result = SkillConfigSchema.safeParse(config);
  if (!result.success) {
    throw new SkillConfigValidationError(sourcePath, result.error.issues);
  }
  return result.data;
}

export async function loadSkillConfigFromPath(
  configPath: string,
): Promise<SkillConfig> {
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_CONFIG;
    }
    throw new SkillConfigAccessError(configPath, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      content.startsWith(UTF8_BOM) ? content.slice(1) : content,
    );
  } catch (error) {
    throw new SkillConfigParseError(configPath, error);
  }

  return validateSkillConfig(parsed, configPath);
}

export function mergeSkillConfigs(
  globalConfig: SkillConfig,
  projectConfig: SkillConfig,
): SkillConfig {
  return {
    directories: [...globalConfig.directories, ...projectConfig.directories],
  };
}

export async function loadSkillConfig(
  options: LoadSkillConfigOptions = {},
): Promise<SkillConfig> {
  const globalPath =
    options.globalPath ?? getGlobalSkillConfigPath(options.homeDirectory);
  const projectPath =
    options.projectPath ?? getProjectSkillConfigPath(options.projectDirectory);
  const [globalConfig, projectConfig] = await Promise.all([
    loadSkillConfigFromPath(globalPath),
    loadSkillConfigFromPath(projectPath),
  ]);

  return mergeSkillConfigs(globalConfig, projectConfig);
}
