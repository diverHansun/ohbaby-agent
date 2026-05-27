import path from "node:path";
import os from "node:os";
import { config as loadDotenv } from "dotenv";
import { Project } from "../project/index.js";

export const OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent";
export const ENV_FILE_NAME = ".env";

export interface LoadRuntimeEnvOptions {
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
}

export interface LoadRuntimeEnvResult {
  readonly globalEnvPath: string;
  readonly projectEnvPath: string;
  readonly projectRoot: string;
}

export function getGlobalEnvPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, OHBABY_CONFIG_DIR_NAME, ENV_FILE_NAME);
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
  const globalEnvPath = getGlobalEnvPath(options.homeDirectory);

  loadDotenv({ path: projectEnvPath, override: false });
  loadDotenv({ path: globalEnvPath, override: false });

  return { globalEnvPath, projectEnvPath, projectRoot };
}
