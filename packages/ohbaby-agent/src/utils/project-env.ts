import { rememberManagedRuntimeEnv } from "./managed-runtime-env.js";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { OHBABY_DIR_NAME, resolveOhbabyHome } from "../paths/index.js";
import { Project } from "../project/index.js";

export const OHBABY_CONFIG_DIR_NAME = OHBABY_DIR_NAME;
export const ENV_FILE_NAME = ".env";

const RESERVED_PROJECT_ENV_KEYS = new Set([
  "OHBABY_HOME",
  "HOME",
  "USERPROFILE",
]);

export interface LoadRuntimeEnvOptions {
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
}

export interface LoadRuntimeEnvResult {
  readonly globalEnvPath: string;
  readonly projectEnvPath: string;
  readonly projectRoot: string;
}

export function getGlobalEnvPath(homeDirectory?: string): string {
  return path.join(resolveOhbabyHome({ homeDirectory }), ENV_FILE_NAME);
}

export function getProjectEnvPath(projectDirectory = process.cwd()): string {
  return path.join(projectDirectory, ENV_FILE_NAME);
}

export async function loadRuntimeEnvIntoProcessEnv(
  options: LoadRuntimeEnvOptions = {},
): Promise<LoadRuntimeEnvResult> {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const projectRoot =
    (await Project.getProjectRoot(projectDirectory)) ??
    path.resolve(projectDirectory);
  const projectEnvPath = getProjectEnvPath(projectRoot);

  // Only the host environment may select the global configuration directory.
  const projectEnv = loadDotenv({ path: projectEnvPath, processEnv: {} });
  for (const [name, value] of Object.entries(projectEnv.parsed ?? {})) {
    if (
      !RESERVED_PROJECT_ENV_KEYS.has(name.toUpperCase()) &&
      !Object.hasOwn(process.env, name)
    ) {
      process.env[name] = value;
    }
  }
  const globalEnvPath = getGlobalEnvPath(options.homeDirectory);
  const beforeGlobal = { ...process.env };
  const loadedGlobal = loadDotenv({ path: globalEnvPath, override: false });
  for (const [name, value] of Object.entries(loadedGlobal.parsed ?? {})) {
    if (beforeGlobal[name] === undefined && process.env[name] === value) {
      rememberManagedRuntimeEnv(name, value);
    }
  }

  return {
    globalEnvPath,
    projectEnvPath,
    projectRoot,
  };
}
