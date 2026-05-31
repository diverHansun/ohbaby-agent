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
  setActiveLLMConfig,
  isLLMConfigCached,
  ConfigError,
} from "./llm/index.js";

export type {
  LLMConfig,
  LLMConfigLoadOptions,
  InterfaceProviderKind,
  ModelJsonConfig,
  ModelJsonModelProfile,
  SetActiveLLMConfigInput,
  SetActiveLLMConfigResult,
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

export {
  getSearchConfig,
  isSearchConfigCached,
  reloadSearchConfig,
  SearchConfigError,
  toSearchProviderConfig,
} from "./tools/index.js";

export type {
  SearchConfig,
  SearchConfigErrorCode,
  SearchConfigLoadOptions,
} from "./tools/index.js";

export {
  SkillConfigAccessError,
  SkillConfigError,
  SkillConfigParseError,
  SkillConfigSchema,
  SkillConfigValidationError,
  SkillDirectoryConfigSchema,
  SkillDirectorySourceSchema,
  GLOBAL_SKILL_CONFIG_DIRECTORY_PRIORITY,
  PROJECT_SKILL_CONFIG_DIRECTORY_PRIORITY,
  getDefaultSkillDirectories,
  getGlobalSkillDirectory,
  getGlobalSkillConfigPath,
  getProjectSkillDirectory,
  getProjectSkillConfigPath,
  loadSkillConfig,
  loadSkillConfigLenient,
  loadSkillConfigFromPath,
  mergeSkillConfigs,
  validateSkillConfig,
} from "./skill/index.js";

export type {
  LoadSkillConfigOptions,
  LoadSkillConfigFromPathOptions,
  LoadSkillConfigLenientOptions,
  SkillConfig,
  SkillConfigErrorCode,
  SkillDirectoryConfig,
} from "./skill/index.js";
