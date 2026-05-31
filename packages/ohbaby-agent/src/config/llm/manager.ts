/**
 * LLM Configuration Manager.
 * Coordinates loading, validation, caching, and hot-reload.
 */

import type { LLMConfig, ModelJsonConfig } from "./types.js";
import { ConfigError } from "./types.js";
import { loadModelJson, loadApiKey, loadEnvFile } from "./loaders.js";
import { validateModelJson, validateApiKey } from "./validation.js";
import {
  setActiveLLMConfig as writeActiveLLMConfig,
  type SetActiveLLMConfigInput,
  type SetActiveLLMConfigResult,
} from "./writer.js";

export interface LLMConfigLoadOptions {
  readonly projectDirectory?: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface CachedLLMConfig {
  readonly config: LLMConfig;
  readonly projectDirectory: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function resolveModelProfiles(
  modelJson: ModelJsonConfig,
): NonNullable<LLMConfig["modelProfiles"]> | undefined {
  const profiles: NonNullable<LLMConfig["modelProfiles"]>[number][] = [];

  if (modelJson.llmParams.contextWindowTokens !== undefined) {
    profiles.push({
      contextWindowTokens: modelJson.llmParams.contextWindowTokens,
      maxOutputTokens: modelJson.llmParams.maxTokens,
      model: modelJson.defaultModel,
      provider: modelJson.provider,
    });
  }

  profiles.push(...(modelJson.models ?? []));

  return profiles.length > 0 ? profiles : undefined;
}

/**
 * Singleton manager for LLM configuration.
 * Provides caching and hot-reload capabilities.
 */
class LLMConfigManager {
  private static instance: LLMConfigManager | null = null;
  private cachedConfig: CachedLLMConfig | null = null;
  private lastError: ConfigError | null = null;

  private constructor() {
    // Use getInstance() to preserve singleton semantics.
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): LLMConfigManager {
    LLMConfigManager.instance ??= new LLMConfigManager();
    return LLMConfigManager.instance;
  }

  /**
   * Reset the singleton instance.
   * Primarily used for testing purposes.
   */
  static resetInstance(): void {
    LLMConfigManager.instance = null;
  }

  /**
   * Load LLM configuration.
   * Returns cached config if available, otherwise loads from file.
   *
   * @throws {ConfigError} If configuration is invalid or missing
   */
  async load(options: LLMConfigLoadOptions = {}): Promise<LLMConfig> {
    const resolvedOptions = this.resolveOptions(options);
    if (
      this.cachedConfig?.projectDirectory ===
        resolvedOptions.projectDirectory &&
      this.cachedConfig.modelJsonPath === resolvedOptions.modelJsonPath &&
      this.cachedConfig.envPath === resolvedOptions.envPath &&
      this.cachedConfig.env === resolvedOptions.env
    ) {
      return this.cachedConfig.config;
    }

    return this.performLoad(resolvedOptions);
  }

  /**
   * Reload configuration from file.
   * Clears cache and forces a fresh load.
   *
   * @throws {ConfigError} If configuration is invalid or missing
   */
  async reload(options: LLMConfigLoadOptions = {}): Promise<LLMConfig> {
    this.cachedConfig = null;
    this.lastError = null;
    return this.performLoad(this.resolveOptions(options));
  }

  async setActive(
    input: SetActiveLLMConfigInput,
  ): Promise<SetActiveLLMConfigResult> {
    const result = await writeActiveLLMConfig(input);
    this.cachedConfig = null;
    this.lastError = null;
    return result;
  }

  /**
   * Get the last error that occurred during loading.
   * Returns null if no error has occurred or after successful load.
   */
  getLastError(): ConfigError | null {
    return this.lastError;
  }

  /**
   * Check if configuration is currently cached.
   */
  isCached(): boolean {
    return this.cachedConfig !== null;
  }

  /**
   * Perform the actual configuration loading.
   */
  private resolveOptions(
    options: LLMConfigLoadOptions,
  ): Required<Pick<LLMConfigLoadOptions, "projectDirectory" | "env">> &
    Pick<LLMConfigLoadOptions, "modelJsonPath" | "envPath"> {
    return {
      projectDirectory: options.projectDirectory ?? process.cwd(),
      env: options.env ?? process.env,
      ...(options.modelJsonPath === undefined
        ? {}
        : { modelJsonPath: options.modelJsonPath }),
      ...(options.envPath === undefined ? {} : { envPath: options.envPath }),
    };
  }

  private async performLoad(
    options: Required<Pick<LLMConfigLoadOptions, "projectDirectory" | "env">> &
      Pick<LLMConfigLoadOptions, "modelJsonPath" | "envPath">,
  ): Promise<LLMConfig> {
    try {
      // Load raw configuration from file
      const rawConfig = await loadModelJson({
        ...(options.modelJsonPath === undefined
          ? {}
          : { modelJsonPath: options.modelJsonPath }),
      });

      // Validate structure and values
      validateModelJson(rawConfig);
      const modelJson = rawConfig;

      // Load API key from environment
      const apiKeyEnvName = modelJson.apiConfig.apiKeyEnv;
      const envFileValues =
        options.envPath === undefined ? {} : await loadEnvFile(options.envPath);
      const apiKey = loadApiKey(apiKeyEnvName, {
        ...envFileValues,
        ...options.env,
      });

      // Validate API key
      validateApiKey(apiKey, apiKeyEnvName);

      // Build final config
      const modelProfiles = resolveModelProfiles(modelJson);
      const config: LLMConfig = {
        provider: modelJson.provider,
        model: modelJson.defaultModel,
        apiKey: apiKey,
        apiKeyEnv: apiKeyEnvName,
        baseUrl: modelJson.apiConfig.baseUrl,
        interfaceProvider:
          modelJson.apiConfig.interfaceProvider ?? "openai-compatible",
        temperature: modelJson.llmParams.temperature,
        maxTokens: modelJson.llmParams.maxTokens,
        ...(modelJson.llmParams.contextWindowTokens === undefined
          ? {}
          : {
              contextWindowTokens: modelJson.llmParams.contextWindowTokens,
            }),
        ...(modelProfiles === undefined ? {} : { modelProfiles }),
      };

      // Cache and return
      this.cachedConfig = {
        config,
        projectDirectory: options.projectDirectory,
        ...(options.modelJsonPath === undefined
          ? {}
          : { modelJsonPath: options.modelJsonPath }),
        ...(options.envPath === undefined ? {} : { envPath: options.envPath }),
        env: options.env,
      };
      this.lastError = null;
      return config;
    } catch (error) {
      // Wrap non-ConfigError errors
      const configError =
        error instanceof ConfigError
          ? error
          : new ConfigError(
              `Failed to load LLM configuration: ${(error as Error).message}`,
              "LOAD_FAILED",
              { cause: error },
            );

      this.lastError = configError;
      throw configError;
    }
  }
}

export { LLMConfigManager };
