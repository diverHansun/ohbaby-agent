/**
 * Configuration loading functions.
 * Handles file I/O and environment variable access.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseDotenv } from 'dotenv';
import { ConfigError } from './types.js';

/** Directory name for ohbaby-agent configuration */
const CONFIG_DIR_NAME = '.ohbaby-agent';

/** Configuration file name */
const MODEL_JSON_NAME = 'model.json';
const ENV_FILE_NAME = '.env';

export type ProjectEnv = Readonly<Record<string, string>>;

/**
 * Get the path to the global model.json configuration file.
 * Location: ~/.ohbaby-agent/model.json
 */
export function getModelJsonPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, CONFIG_DIR_NAME, MODEL_JSON_NAME);
}

/**
 * Parse project-local environment variables from .env without mutating
 * process.env. Parent shell variables are applied by loadApiKey().
 */
export async function loadProjectEnv(
  directory = process.cwd(),
): Promise<ProjectEnv> {
  const envPath = path.join(directory, ENV_FILE_NAME);
  try {
    return parseDotenv(await fs.readFile(envPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new ConfigError(
      `Failed to read project .env file: ${(error as Error).message}`,
      'LOAD_FAILED',
      { path: envPath, cause: error }
    );
  }
}

/**
 * Load and parse the model.json configuration file.
 * Throws ConfigError if file does not exist or contains invalid JSON.
 */
export async function loadModelJson(): Promise<unknown> {
  const configPath = getModelJsonPath();

  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `Configuration file not found: ${configPath}. Create ~/.ohbaby-agent/model.json before starting ohbaby-agent.`,
        'FILE_NOT_FOUND',
        { path: configPath }
      );
    }
    throw new ConfigError(
      `Failed to read configuration file: ${(error as Error).message}`,
      'LOAD_FAILED',
      { path: configPath, cause: error }
    );
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in configuration file: ${(error as Error).message}`,
      'INVALID_JSON',
      { path: configPath, cause: error }
    );
  }
}

/**
 * Load API key from environment variable.
 * Returns undefined if the environment variable is not set.
 */
export function loadApiKey(
  envVarName: string,
  projectEnv: ProjectEnv = {},
): string | undefined {
  return process.env[envVarName] ?? projectEnv[envVarName];
}
