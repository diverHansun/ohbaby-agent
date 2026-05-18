/**
 * Provider-backed client creation and initialization.
 *
 * This module handles the instantiation of the configured provider client.
 *
 * Design Principles:
 * - SRP: Only responsible for creating and configuring the client
 * - Fail Fast: Configuration errors from config module propagate immediately
 * - KISS: Minimal logic, delegate configuration to config module
 *
 * Dependencies:
 * - config module: Provides validated LLM configuration
 */

import { getLLMConfig } from '../../config/index.js';
import { createProvider } from '../../services/providers/index.js';
import type { LLMClientInstance } from './types.js';

export interface CreateLLMClientOptions {
  readonly projectDirectory?: string;
}

/**
 * Create and initialize an LLM client instance.
 *
 * Loads configuration from the config module (which reads from ~/.ohbaby-agent/model.json
 * and environment variables). Configuration validation is handled by the config module.
 *
 * @returns Promise resolving to client instance with provider and configuration
 * @throws {ConfigError} If configuration is missing or invalid (from config module)
 *
 * @example
 * ```typescript
 * const llmClient = await createLLMClient();
 * // Use llmClient.provider.client for direct SDK calls
 * // Use llmClient.config for configuration values
 * ```
 */
export async function createLLMClient(
  options: CreateLLMClientOptions = {},
): Promise<LLMClientInstance> {
  // Load validated configuration from config module
  const config = await getLLMConfig(options);

  // Create provider-specific SDK instance
  const provider = createProvider({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  // Return configured client instance
  // Note: apiKey is intentionally excluded from the returned config for security
  return {
    provider,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    },
  };
}
