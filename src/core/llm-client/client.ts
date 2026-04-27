/**
 * OpenAI SDK client creation and initialization.
 *
 * This module handles the instantiation of the OpenAI SDK client.
 *
 * Design Principles:
 * - SRP: Only responsible for creating and configuring the client
 * - Fail Fast: Configuration errors from config module propagate immediately
 * - KISS: Minimal logic, delegate configuration to config module
 *
 * Dependencies:
 * - config module: Provides validated LLM configuration
 */

import OpenAI from 'openai';
import { getLLMConfig } from '../../config/index.js';
import type { LLMClientInstance } from './types.js';

/**
 * Create and initialize an LLM client instance.
 *
 * Loads configuration from the config module (which reads from ~/.ohbaby-agent/model.json
 * and environment variables). Configuration validation is handled by the config module.
 *
 * @returns Promise resolving to client instance with OpenAI SDK and configuration
 * @throws {ConfigError} If configuration is missing or invalid (from config module)
 *
 * @example
 * ```typescript
 * const llmClient = await createLLMClient();
 * // Use llmClient.client for direct SDK calls
 * // Use llmClient.config for configuration values
 * ```
 */
export async function createLLMClient(): Promise<LLMClientInstance> {
  // Load validated configuration from config module
  const config = await getLLMConfig();

  // Create OpenAI SDK instance
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  // Return configured client instance
  // Note: apiKey is intentionally excluded from the returned config for security
  return {
    client,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    },
  };
}
