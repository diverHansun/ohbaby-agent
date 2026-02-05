/**
 * Validation functions for LLM configuration.
 * All functions are pure and stateless.
 */

import { ConfigError } from './types.js';
import type { ModelJsonConfig } from './types.js';

/**
 * Validate the structure and values of ModelJsonConfig.
 * Throws ConfigError if validation fails.
 */
export function validateModelJson(config: unknown): asserts config is ModelJsonConfig {
  if (!config || typeof config !== 'object') {
    throw new ConfigError(
      'Invalid model.json: expected an object',
      'INVALID_JSON'
    );
  }

  const obj = config as Record<string, unknown>;
  const errors: string[] = [];

  // Validate required top-level fields
  if (!obj.provider || typeof obj.provider !== 'string') {
    errors.push('provider (string) is required');
  }

  if (!obj.defaultModel || typeof obj.defaultModel !== 'string') {
    errors.push('defaultModel (string) is required');
  }

  // Validate apiConfig
  if (!obj.apiConfig || typeof obj.apiConfig !== 'object') {
    errors.push('apiConfig (object) is required');
  } else {
    const apiConfig = obj.apiConfig as Record<string, unknown>;

    if (!apiConfig.baseUrl || typeof apiConfig.baseUrl !== 'string') {
      errors.push('apiConfig.baseUrl (string) is required');
    }

    if (!apiConfig.apiKeyEnv || typeof apiConfig.apiKeyEnv !== 'string') {
      errors.push('apiConfig.apiKeyEnv (string) is required');
    }
  }

  // Validate llmParams
  if (!obj.llmParams || typeof obj.llmParams !== 'object') {
    errors.push('llmParams (object) is required');
  } else {
    const llmParams = obj.llmParams as Record<string, unknown>;

    if (typeof llmParams.temperature !== 'number') {
      errors.push('llmParams.temperature (number) is required');
    } else if (llmParams.temperature < 0 || llmParams.temperature > 2) {
      throw new ConfigError(
        `Invalid temperature: ${llmParams.temperature}. Must be between 0 and 2`,
        'INVALID_TEMPERATURE',
        { value: llmParams.temperature }
      );
    }

    if (typeof llmParams.maxTokens !== 'number') {
      errors.push('llmParams.maxTokens (number) is required');
    } else if (llmParams.maxTokens <= 0 || !Number.isInteger(llmParams.maxTokens)) {
      throw new ConfigError(
        `Invalid maxTokens: ${llmParams.maxTokens}. Must be a positive integer`,
        'INVALID_MAX_TOKENS',
        { value: llmParams.maxTokens }
      );
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Invalid model.json: ${errors.join('; ')}`,
      'MISSING_FIELD',
      { missingFields: errors }
    );
  }
}

/**
 * Validate that API key exists and is not empty.
 * Throws ConfigError if validation fails.
 */
export function validateApiKey(apiKey: string | undefined, envVarName: string): asserts apiKey is string {
  if (apiKey === undefined) {
    throw new ConfigError(
      `API key not found: environment variable '${envVarName}' is not set`,
      'MISSING_API_KEY',
      { envVarName }
    );
  }

  if (apiKey.trim() === '') {
    throw new ConfigError(
      `API key is empty: environment variable '${envVarName}' is set but empty`,
      'EMPTY_API_KEY',
      { envVarName }
    );
  }
}
