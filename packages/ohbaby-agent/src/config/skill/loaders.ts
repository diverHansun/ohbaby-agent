import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SkillConfigAccessError,
  SkillConfigParseError,
  SkillConfigSchema,
  SkillConfigValidationError,
} from "./types.js";
import type { SkillConfig, SkillDirectoryConfig } from "./types.js";

export const OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent";
export const SKILL_CONFIG_DIR_NAME = "skills";
export const SKILL_CONFIG_FILE_NAME = "settings.json";
export const SKILL_DIR_NAME = "skill";
export const SKILLS_DIR_NAME = "skills";

const EMPTY_CONFIG: SkillConfig = { directories: [] };
const UTF8_BOM = "\uFEFF";

const PRIORITY = {
  plugin: 10,
  "codex-home": 20,
  "user-compatible": 30,
  "user-native": 40,
  "project-compatible": 50,
  "project-native": 60,
} as const;

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

export function getGlobalSkillDirectory(
  homeDirectory = os.homedir(),
  _environment?: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(homeDirectory, OHBABY_CONFIG_DIR_NAME, SKILL_DIR_NAME);
}

function getGlobalSkillsDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, OHBABY_CONFIG_DIR_NAME, SKILLS_DIR_NAME);
}

export function getProjectSkillDirectory(
  projectDirectory = process.cwd(),
): string {
  return path.join(projectDirectory, OHBABY_CONFIG_DIR_NAME, SKILL_DIR_NAME);
}

function getProjectSkillsDirectory(projectDirectory = process.cwd()): string {
  return path.join(projectDirectory, OHBABY_CONFIG_DIR_NAME, SKILLS_DIR_NAME);
}

function getCodexHomeSkillsDirectory(
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(
    environment.CODEX_HOME ?? path.join(homeDirectory, ".codex"),
    SKILLS_DIR_NAME,
  );
}

export function getDefaultSkillDirectories(
  input: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
    readonly projectDirectory?: string;
  } = {},
): readonly SkillDirectoryConfig[] {
  const homeDirectory = input.homeDirectory ?? os.homedir();
  const environment = input.environment ?? process.env;
  const projectDirectory = input.projectDirectory ?? process.cwd();

  return [
    {
      path: getCodexHomeSkillsDirectory(homeDirectory, environment),
      priority: PRIORITY["codex-home"],
      scope: "user",
      source: "codex-home",
    },
    {
      path: path.join(homeDirectory, ".claude", SKILLS_DIR_NAME),
      priority: PRIORITY["user-compatible"],
      scope: "user",
      source: "claude-compatible",
    },
    {
      path: path.join(homeDirectory, ".agents", SKILLS_DIR_NAME),
      priority: PRIORITY["user-compatible"],
      scope: "user",
      source: "agents-compatible",
    },
    {
      path: getGlobalSkillsDirectory(homeDirectory),
      priority: PRIORITY["user-native"],
      scope: "user",
      source: "user-native",
    },
    {
      path: getGlobalSkillDirectory(homeDirectory),
      priority: PRIORITY["user-native"],
      scope: "user",
      source: "user-native",
    },
    {
      path: path.join(projectDirectory, ".claude", SKILLS_DIR_NAME),
      priority: PRIORITY["project-compatible"],
      scope: "project",
      source: "claude-compatible",
    },
    {
      path: path.join(projectDirectory, ".agents", SKILLS_DIR_NAME),
      priority: PRIORITY["project-compatible"],
      scope: "project",
      source: "agents-compatible",
    },
    {
      path: getProjectSkillsDirectory(projectDirectory),
      priority: PRIORITY["project-native"],
      scope: "project",
      source: "project-native",
    },
    {
      path: getProjectSkillDirectory(projectDirectory),
      priority: PRIORITY["project-native"],
      scope: "project",
      source: "project-native",
    },
  ];
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
