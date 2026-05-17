export {
  AGENTS_CONFIG_DIR_NAME,
  AGENTS_CONFIG_FILE_NAME,
  OHBABY_CONFIG_DIR_NAME,
  getGlobalAgentsConfigPath,
  getProjectAgentsConfigPath,
  loadAgentConfig,
} from "./loaders.js";

export {
  AgentConfigAccessError,
  AgentConfigError,
  AgentConfigParseError,
  AgentConfigValidationError,
  AgentConfigSchema,
  AgentModeSchema,
  AgentsConfigSchema,
  CriticalOperationsConfigSchema,
  HexColorSchema,
  ModelIdSchema,
  PermissionConfigSchema,
  PermissionValueSchema,
  ToolsConfigSchema,
} from "./types.js";

export type {
  AgentConfig,
  AgentConfigErrorCode,
  AgentMode,
  AgentsConfig,
  CriticalOperationsConfig,
  PermissionConfig,
  PermissionValue,
  ToolsConfig,
} from "./types.js";
