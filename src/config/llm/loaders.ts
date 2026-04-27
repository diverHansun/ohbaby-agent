/**
 * Configuration loading functions.
 * Handles file I/O and environment variable access.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigError } from './types.js';

/** Directory name for ohbaby-code configuration */
const CONFIG_DIR_NAME = '.ohbaby-code';

/** Configuration file name */
const MODEL_JSON_NAME = 'model.json';

/**
 * Get the path to the global model.json configuration file.
 * Location: ~/.ohbaby-code/model.json
 */
export function getModelJsonPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, CONFIG_DIR_NAME, MODEL_JSON_NAME);
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
        `Configuration file not found: ${configPath}`,
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
export function loadApiKey(envVarName: string): string | undefined {
  return process.env[envVarName];
}
