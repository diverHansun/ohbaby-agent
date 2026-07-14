import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { migrateOhbabyConfig } from "../migration/index.js";
import { OHBABY_DIR_NAME, resolveOhbabyHome } from "../paths/index.js";
import { Project } from "../project/index.js";

export const OHBABY_CONFIG_DIR_NAME = OHBABY_DIR_NAME;
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

  loadDotenv({ path: projectEnvPath, override: false });
  await migrateOhbabyConfig({
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    projectDirectory: projectRoot,
  });
  const globalEnvPath = getGlobalEnvPath(options.homeDirectory);
  loadDotenv({ path: globalEnvPath, override: false });

  return { globalEnvPath, projectEnvPath, projectRoot };
}
