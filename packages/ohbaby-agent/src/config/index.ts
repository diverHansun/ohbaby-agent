/**
 * Configuration module entry point.
 *
 * Aggregates and re-exports configuration from all sub-modules.
 * Consumers should import from '@/config' rather than sub-modules directly.
 */

// LLM configuration
export {
  getLLMConfig,
  reloadLLMConfig,
  isLLMConfigCached,
  ConfigError,
} from './llm/index.js';

export type {
  LLMConfig,
  ModelJsonConfig,
  ConfigErrorCode,
} from './llm/index.js';
