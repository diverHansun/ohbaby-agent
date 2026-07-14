import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OHBABY_DIR_NAME,
  resolveLegacyOhbabyHome,
  resolveLegacyProjectOhbabyRoot,
  resolveOhbabyHome,
  resolveProjectOhbabyRoot,
  resolveReadPathWithLegacy,
} from "../../paths/index.js";
import {
  SkillConfigAccessError,
  SkillConfigParseError,
  SkillConfigSchema,
  SkillConfigValidationError,
} from "./types.js";
import type { SkillConfig, SkillDirectoryConfig } from "./types.js";

export const OHBABY_CONFIG_DIR_NAME = OHBABY_DIR_NAME;
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

export const GLOBAL_SKILL_CONFIG_DIRECTORY_PRIORITY =
  PRIORITY["user-native"] + 5;
export const PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY =
  PRIORITY["project-native"] + 5;

export interface LoadSkillConfigOptions {
  readonly globalPath?: string;
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
  readonly projectPath?: string;
}

export interface LoadSkillConfigFromPathOptions {
  readonly defaultDirectoryPriority?: number;
  readonly relativeDirectoryBase?: string;
}

export interface LoadSkillConfigLenientOptions extends LoadSkillConfigOptions {
  readonly onWarning?: (
    error:
      | SkillConfigAccessError
      | SkillConfigParseError
      | SkillConfigValidationError,
  ) => void;
}

export function getGlobalSkillConfigPath(homeDirectory?: string): string {
  return path.join(
    resolveOhbabyHome({ homeDirectory }),
    SKILL_CONFIG_DIR_NAME,
    SKILL_CONFIG_FILE_NAME,
  );
}

export function getProjectSkillConfigPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(
    resolveProjectOhbabyRoot(projectDirectory),
    SKILL_CONFIG_DIR_NAME,
    SKILL_CONFIG_FILE_NAME,
  );
}

function getLegacyGlobalSkillConfigPath(homeDirectory?: string): string {
  return path.join(
    resolveLegacyOhbabyHome({ homeDirectory }),
    SKILL_CONFIG_DIR_NAME,
    SKILL_CONFIG_FILE_NAME,
  );
}

function getLegacyProjectSkillConfigPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(
    resolveLegacyProjectOhbabyRoot(projectDirectory),
    SKILL_CONFIG_DIR_NAME,
    SKILL_CONFIG_FILE_NAME,
  );
}

export function getGlobalSkillDirectory(
  homeDirectory?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.join(
    resolveOhbabyHome({ environment, homeDirectory }),
    SKILL_DIR_NAME,
  );
}

function getGlobalSkillsDirectory(
  homeDirectory?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.join(
    resolveOhbabyHome({ environment, homeDirectory }),
    SKILLS_DIR_NAME,
  );
}

export function getProjectSkillDirectory(
  projectDirectory = process.cwd(),
): string {
  return path.join(resolveProjectOhbabyRoot(projectDirectory), SKILL_DIR_NAME);
}

function getProjectSkillsDirectory(projectDirectory = process.cwd()): string {
  return path.join(resolveProjectOhbabyRoot(projectDirectory), SKILLS_DIR_NAME);
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
      path: getGlobalSkillsDirectory(input.homeDirectory, environment),
      priority: PRIORITY["user-native"],
      scope: "user",
      source: "user-native",
    },
    {
      path: getGlobalSkillDirectory(input.homeDirectory, environment),
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

function resolveDirectoryConfig(
  directory: SkillDirectoryConfig,
  input: {
    readonly configPath: string;
    readonly defaultDirectoryPriority?: number;
    readonly relativeDirectoryBase?: string;
  },
): SkillDirectoryConfig {
  const baseDirectory =
    input.relativeDirectoryBase ?? path.dirname(input.configPath);
  const resolvedPath = path.isAbsolute(directory.path)
    ? path.normalize(directory.path)
    : path.resolve(baseDirectory, directory.path);
  return {
    ...directory,
    path: resolvedPath,
    ...(directory.priority === undefined &&
    input.defaultDirectoryPriority !== undefined
      ? { priority: input.defaultDirectoryPriority }
      : {}),
  };
}

function resolveSkillConfig(
  config: SkillConfig,
  input: {
    readonly configPath: string;
    readonly defaultDirectoryPriority?: number;
    readonly relativeDirectoryBase?: string;
  },
): SkillConfig {
  return {
    directories: config.directories.map((directory) =>
      resolveDirectoryConfig(directory, input),
    ),
  };
}

export async function loadSkillConfigFromPath(
  configPath: string,
  options: LoadSkillConfigFromPathOptions = {},
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

  return resolveSkillConfig(validateSkillConfig(parsed, configPath), {
    configPath,
    defaultDirectoryPriority: options.defaultDirectoryPriority,
    relativeDirectoryBase: options.relativeDirectoryBase,
  });
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
    options.globalPath ??
    (await resolveReadPathWithLegacy(
      getGlobalSkillConfigPath(options.homeDirectory),
      [getLegacyGlobalSkillConfigPath(options.homeDirectory)],
    ));
  const projectPath =
    options.projectPath ??
    (await resolveReadPathWithLegacy(
      getProjectSkillConfigPath(options.projectDirectory),
      [getLegacyProjectSkillConfigPath(options.projectDirectory)],
    ));
  const [globalConfig, projectConfig] = await Promise.all([
    loadSkillConfigFromPath(globalPath, {
      defaultDirectoryPriority: GLOBAL_SKILL_CONFIG_DIRECTORY_PRIORITY,
    }),
    loadSkillConfigFromPath(projectPath, {
      defaultDirectoryPriority: PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY,
    }),
  ]);

  return mergeSkillConfigs(globalConfig, projectConfig);
}

async function loadSkillConfigFromPathLenient(
  configPath: string,
  options: LoadSkillConfigFromPathOptions & {
    readonly onWarning?: LoadSkillConfigLenientOptions["onWarning"];
  },
): Promise<SkillConfig> {
  try {
    return await loadSkillConfigFromPath(configPath, options);
  } catch (error) {
    if (
      error instanceof SkillConfigAccessError ||
      error instanceof SkillConfigParseError ||
      error instanceof SkillConfigValidationError
    ) {
      options.onWarning?.(error);
      return EMPTY_CONFIG;
    }
    throw error;
  }
}

export async function loadSkillConfigLenient(
  options: LoadSkillConfigLenientOptions = {},
): Promise<SkillConfig> {
  const globalPath =
    options.globalPath ??
    (await resolveReadPathWithLegacy(
      getGlobalSkillConfigPath(options.homeDirectory),
      [getLegacyGlobalSkillConfigPath(options.homeDirectory)],
    ));
  const projectPath =
    options.projectPath ??
    (await resolveReadPathWithLegacy(
      getProjectSkillConfigPath(options.projectDirectory),
      [getLegacyProjectSkillConfigPath(options.projectDirectory)],
    ));
  const [globalConfig, projectConfig] = await Promise.all([
    loadSkillConfigFromPathLenient(globalPath, {
      defaultDirectoryPriority: GLOBAL_SKILL_CONFIG_DIRECTORY_PRIORITY,
      onWarning: options.onWarning,
    }),
    loadSkillConfigFromPathLenient(projectPath, {
      defaultDirectoryPriority: PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY,
      onWarning: options.onWarning,
    }),
  ]);

  return mergeSkillConfigs(globalConfig, projectConfig);
}
