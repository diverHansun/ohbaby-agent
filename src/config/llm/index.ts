/**
 * Public API for the LLM configuration module.
 *
 * This module exports convenience functions for accessing LLM configuration.
 * Internal implementation details (LLMConfigManager) are not exposed.
 */

import { LLMConfigManager } from './manager.js';
import type { LLMConfig } from './types.js';

// Re-export types for consumers
export type { LLMConfig, ModelJsonConfig, ConfigErrorCode } from './types.js';
export { ConfigError } from './types.js';

/**
 * Get LLM configuration.
 *
 * On first call, loads configuration from ~/.iris-code/model.json
 * and reads API key from environment variable specified in the config.
 * Subsequent calls return cached configuration.
 *
 * @returns Resolved LLM configuration
 * @throws {ConfigError} If configuration file is missing, invalid, or API key is not set
 *
 * @example
 * ```typescript
 * import { getLLMConfig } from '@/config';
 *
 * const config = await getLLMConfig();
 * console.log(config.model);  // 'gpt-4'
 * ```
 */
export async function getLLMConfig(): Promise<LLMConfig> {
  return LLMConfigManager.getInstance().load();
}

/**
 * Reload LLM configuration from file.
 *
 * Clears the cached configuration and loads fresh from disk.
 * Use this after user modifies model.json to apply changes without restart.
 *
 * @returns Newly loaded LLM configuration
 * @throws {ConfigError} If configuration file is missing, invalid, or API key is not set
 *
 * @example
 * ```typescript
 * import { reloadLLMConfig } from '@/config';
 *
 * // After user edits model.json
 * const newConfig = await reloadLLMConfig();
 * ```
 */
export async function reloadLLMConfig(): Promise<LLMConfig> {
  return LLMConfigManager.getInstance().reload();
}

/**
 * Check if LLM configuration is currently cached.
 *
 * @returns true if configuration is cached, false otherwise
 */
export function isLLMConfigCached(): boolean {
  return LLMConfigManager.getInstance().isCached();
}

// Export for testing purposes only
export { LLMConfigManager as _LLMConfigManager } from './manager.js';
