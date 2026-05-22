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

export {
  DEFAULT_MCP_ENABLED,
  DEFAULT_MCP_TIMEOUT,
  DEFAULT_MCP_TRUST,
  McpConfigAccessError,
  McpConfigError,
  McpConfigParseError,
  McpConfigValidationError,
  McpHttpConfigSchema,
  McpServerConfigSchema,
  McpServersConfigSchema,
  McpSseConfigSchema,
  McpStdioConfigSchema,
  getGlobalMcpConfigPath,
  getProjectMcpConfigPath,
  loadMcpConfig,
  loadMcpConfigFromPath,
  mergeMcpConfigs,
  validateMcpConfig,
} from "./mcp/index.js";

export type {
  LoadMcpConfigOptions,
  McpConfigErrorCode,
  McpHttpConfig,
  McpServerConfig,
  McpServersConfig,
  McpSseConfig,
  McpStdioConfig,
} from "./mcp/index.js";
