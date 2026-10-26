import { coordinateModelConfig } from "./config-coordination.js";
/**
 * Configuration loading functions.
 * Handles file I/O and environment variable access.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  resolveLegacyOhbabyHome,
  resolveOhbabyHome,
  resolveReadPathWithLegacy,
} from "../../paths/index.js";
import { ConfigError } from "ohbaby-llm";
import { parseEnvFile } from "./env-file.js";

/** Directory name for ohbaby-agent configuration */
/** Configuration file name */
const MODEL_JSON_NAME = "model.json";

export interface LoadModelJsonOptions {
  readonly modelJsonPath?: string;
}

/**
 * Get the path to the global model.json configuration file.
 * Location: ~/.ohbaby/model.json
 */
export function getModelJsonPath(homeDirectory?: string): string {
  return path.join(resolveOhbabyHome({ homeDirectory }), MODEL_JSON_NAME);
}

function getLegacyModelJsonPath(homeDirectory?: string): string {
  return path.join(resolveLegacyOhbabyHome({ homeDirectory }), MODEL_JSON_NAME);
}

/**
 * Load and parse the model.json configuration file.
 * Throws ConfigError if file does not exist or contains invalid JSON.
 */
export async function loadModelJson(
  options: LoadModelJsonOptions = {},
): Promise<unknown> {
  return coordinateModelConfig(options.modelJsonPath, async () => {
    const configPath = await resolveModelJsonReadPath(options);

    let content: string;
    try {
      content = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConfigError(
          `Configuration file not found: ${configPath}. Create ~/.ohbaby/model.json before starting ohbaby-agent.`,
          "FILE_NOT_FOUND",
          { path: configPath },
        );
      }
      throw new ConfigError(
        `Failed to read configuration file: ${(error as Error).message}`,
        "LOAD_FAILED",
        { path: configPath, cause: error },
      );
    }

    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new ConfigError(
        `Invalid JSON in configuration file: ${(error as Error).message}`,
        "INVALID_JSON",
        { path: configPath, cause: error },
      );
    }
  });
}

/** The effective source path can differ from the publication target during home migration. */
export function resolveModelJsonReadPath(
  options: LoadModelJsonOptions = {},
): Promise<string> {
  return options.modelJsonPath === undefined
    ? resolveReadPathWithLegacy(getModelJsonPath(), [getLegacyModelJsonPath()])
    : Promise.resolve(options.modelJsonPath);
}

/**
 * Load API key from environment variable.
 * Returns undefined if the environment variable is not set.
 */
export function loadApiKey(
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[envVarName];
}

export async function loadEnvFile(
  envPath: string,
): Promise<Record<string, string>> {
  return coordinateModelConfig(undefined, async () => {
    let content: string;
    try {
      content = await fs.readFile(envPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new ConfigError(
        `Failed to read .env file: ${(error as Error).message}`,
        "LOAD_FAILED",
        { path: envPath, cause: error },
      );
    }

    return parseEnvFile(content);
  });
}
