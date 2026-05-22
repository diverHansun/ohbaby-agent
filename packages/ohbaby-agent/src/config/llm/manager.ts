/**
 * LLM Configuration Manager.
 * Coordinates loading, validation, caching, and hot-reload.
 */

import type { LLMConfig } from "./types.js";
import { ConfigError } from "./types.js";
import { loadModelJson, loadApiKey, loadProjectEnv } from "./loaders.js";
import { validateModelJson, validateApiKey } from "./validation.js";

export interface LLMConfigLoadOptions {
  readonly projectDirectory?: string;
}

interface CachedLLMConfig {
  readonly config: LLMConfig;
  readonly projectDirectory: string;
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
    const projectDirectory = options.projectDirectory ?? process.cwd();
    if (this.cachedConfig?.projectDirectory === projectDirectory) {
      return this.cachedConfig.config;
    }

    return this.performLoad(projectDirectory);
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
    return this.performLoad(options.projectDirectory ?? process.cwd());
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
  private async performLoad(projectDirectory: string): Promise<LLMConfig> {
    try {
      // Load raw configuration from file
      const rawConfig = await loadModelJson();

      // Validate structure and values
      validateModelJson(rawConfig);
      const modelJson = rawConfig;

      // Load API key from environment
      const apiKeyEnvName = modelJson.apiConfig.apiKeyEnv;
      const apiKeyFromShell = loadApiKey(apiKeyEnvName);
      const projectEnv =
        apiKeyFromShell === undefined
          ? await loadProjectEnv(projectDirectory)
          : {};
      const apiKey = apiKeyFromShell ?? loadApiKey(apiKeyEnvName, projectEnv);

      // Validate API key
      validateApiKey(apiKey, apiKeyEnvName);

      // Build final config
      const config: LLMConfig = {
        provider: modelJson.provider,
        model: modelJson.defaultModel,
        apiKey: apiKey,
        baseUrl: modelJson.apiConfig.baseUrl,
        temperature: modelJson.llmParams.temperature,
        maxTokens: modelJson.llmParams.maxTokens,
      };

      // Cache and return
      this.cachedConfig = { config, projectDirectory };
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
