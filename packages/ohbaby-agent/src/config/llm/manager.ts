/**
 * LLM Configuration Manager.
 * Coordinates loading, validation, caching, and hot-reload.
 */

import type { LLMConfig } from './types.js';
import { ConfigError } from './types.js';
import { loadModelJson, loadApiKey } from './loaders.js';
import { validateModelJson, validateApiKey } from './validation.js';

/**
 * Singleton manager for LLM configuration.
 * Provides caching and hot-reload capabilities.
 */
class LLMConfigManager {
  private static instance: LLMConfigManager | null = null;
  private cachedConfig: LLMConfig | null = null;
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
  async load(): Promise<LLMConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    return this.performLoad();
  }

  /**
   * Reload configuration from file.
   * Clears cache and forces a fresh load.
   *
   * @throws {ConfigError} If configuration is invalid or missing
   */
  async reload(): Promise<LLMConfig> {
    this.cachedConfig = null;
    this.lastError = null;
    return this.performLoad();
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
  private async performLoad(): Promise<LLMConfig> {
    try {
      // Load raw configuration from file
      const rawConfig = await loadModelJson();

      // Validate structure and values
      validateModelJson(rawConfig);
      const modelJson = rawConfig;

      // Load API key from environment
      const apiKeyEnvName = modelJson.apiConfig.apiKeyEnv;
      const apiKey = loadApiKey(apiKeyEnvName);

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
      this.cachedConfig = config;
      this.lastError = null;
      return config;
    } catch (error) {
      // Wrap non-ConfigError errors
      const configError =
        error instanceof ConfigError
          ? error
          : new ConfigError(
              `Failed to load LLM configuration: ${(error as Error).message}`,
              'LOAD_FAILED',
              { cause: error }
            );

      this.lastError = configError;
      throw configError;
    }
  }
}

export { LLMConfigManager };
