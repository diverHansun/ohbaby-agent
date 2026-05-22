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
} from "./llm/index.js";

export type {
  LLMConfig,
  LLMConfigLoadOptions,
  ModelJsonConfig,
  ConfigErrorCode,
} from "./llm/index.js";

export {
  AgentConfigAccessError,
  AgentConfigError,
  AgentConfigParseError,
  AgentConfigSchema,
  AgentConfigValidationError,
  AgentsConfigSchema,
  getGlobalAgentsConfigPath,
  getProjectAgentsConfigPath,
  loadAgentConfig,
} from "./agents/index.js";

export type {
  AgentConfig,
  AgentConfigErrorCode,
  AgentMode,
  AgentsConfig,
  PermissionConfig,
  PermissionValue,
  ToolsConfig,
} from "./agents/index.js";
