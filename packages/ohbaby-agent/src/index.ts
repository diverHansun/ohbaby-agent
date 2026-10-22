export type {
  UiCommandCorrelation,
  UiCommandRecord,
  UiCommandRecorder,
} from "./host/command-record.js";
export { createInProcessUiBackendClient } from "./adapters/ui-inprocess.js";
export type { UiPromptQueueExecutionPort } from "./adapters/ui-inprocess.js";
export {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
} from "./adapters/ui-persistent.js";
export type {
  PersistentUiBackendClient,
  PersistentUiBackendOptions,
} from "./adapters/ui-persistent.js";
export { buildCoreAPIImpl } from "./host/core-api-factory.js";
export {
  createStructuredUiCommandRecorder,
  type StructuredUiCommandRecorder,
  type StructuredUiCommandRecorderOptions,
} from "./host/command-recorder.js";
export {
  createUiCommandGateway,
  type RecordedUiBackendClient,
  type UiCommandGatewayOptions,
} from "./host/ui-command-gateway.js";
export type {
  CoreApiFactoryOptions,
  CoreApiHost,
} from "./host/core-api-factory.js";
export * from "./commands/index.js";
export {
  AgentConfigAccessError,
  AgentConfigError,
  AgentConfigParseError,
  AgentConfigSchema,
  AgentConfigValidationError,
  AgentsConfigSchema,
  ConfigError,
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
  getGlobalAgentsConfigPath,
  getGlobalMcpConfigPath,
  getLLMConfig,
  getProjectAgentsConfigPath,
  getProjectMcpConfigPath,
  isLLMConfigCached,
  loadAgentConfig,
  loadMcpConfig,
  loadMcpConfigFromPath,
  mergeMcpConfigs,
  reloadLLMConfig,
  validateMcpConfig,
} from "./config/index.js";
export type {
  AgentConfig as ConfigAgentConfig,
  AgentConfigErrorCode,
  AgentMode as ConfigAgentMode,
  AgentsConfig as ConfigAgentsConfig,
  ConfigErrorCode,
  LLMConfig,
  LoadMcpConfigOptions,
  McpConfigErrorCode,
  McpHttpConfig,
  McpServerConfig,
  McpServersConfig,
  McpSseConfig,
  McpStdioConfig,
  ModelJsonConfig,
  PermissionConfig as ConfigPermissionConfig,
  PermissionValue as ConfigPermissionValue,
  ToolsConfig as ConfigToolsConfig,
} from "./config/index.js";
export {
  AgentManager,
  AgentRegistry,
  AgentService,
  BUILTIN_AGENTS,
  BUILTIN_AGENT_NAMES,
  buildAgent,
  exploreAgent,
  planAgent,
  researchAgent,
  toolsConfigToRecord,
} from "./agents/index.js";
export type { AgentServiceOptions, RuntimeAgent } from "./agents/index.js";
export * from "./core/agents/index.js";
export * from "./core/system-prompt/index.js";
/**
 * Public API for the LLM Client module.
 *
 * This module exports the core functions and types needed to interact
 * with the configured LLM provider through the shared streaming interface.
 *
 * Design Principle: Interface Segregation
 * Consumers import only what they need. The module provides three categories:
 * 1. Functions: createLLMClient, streamResponse
 * 2. Types: LLMClientInstance, StreamingResponse, etc.
 * 3. Error Classes: APIUserAbortError (deprecated in ohbaby-llm; prefer isAbortError there)
 */

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ProviderStreamIdleTimeoutError,
} from "ohbaby-llm";

// Export core functions
export { createLLMClient } from "./core/llm-client/create-llm-client.js";
export { isContextOverflowError, ToolCallParseError } from "ohbaby-llm";
export {
  DEFAULT_PROVIDER_RETRY_POLICY,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
  isRetryableProviderError,
  nextRetryDelayMs,
  parseRetryAfterMs,
  providerErrorStatus,
  retryReason,
} from "ohbaby-llm";
export type { CreateLLMClientOptions } from "./core/llm-client/create-llm-client.js";
export { streamResponse, resolvePreparedRequestSettings } from "ohbaby-llm";

// Export type definitions for consumers
export type {
  ModelResponseSnapshot,
  ToolCallSnapshot,
  // Main interfaces
  LLMClientInstance,
  StreamingResponse,
  // Message and token types
  ModelMessage,
  StreamingTokenUsage,
  TokenUsage,
  // Tool-related types
  ParsedToolCall,
  // Metadata types
  ModelFinishReason,
  StreamStopReason,
} from "ohbaby-llm";
export type { ProviderRetryEvent, ProviderRetryPolicy } from "ohbaby-llm";
export type {
  ModelToolDefinition,
  ModelToolCall,
  LLMRequestPurpose,
  PromptCacheRequestStrategy,
} from "ohbaby-llm";

// Kept for compatibility; deprecated in ohbaby-llm in favor of isAbortError.
export { APIUserAbortError } from "ohbaby-llm";

export * from "./mcp/index.js";
export * from "./migration/index.js";
export * from "./observability/index.js";
export * from "./project/index.js";
export * from "./paths/index.js";
export * from "./runtime/interaction-broker/index.js";
export * from "./runtime/prompt-scheduler/index.js";
export { SessionRunBusyError } from "./runtime/run-ledger/index.js";
export * from "./sandbox/index.js";
export * from "./shell/index.js";
export * from "./snapshot/index.js";
export { getAgentPackageVersion } from "./package-version.js";
export {
  GLOBAL_SESSION_PAGE_DEFAULT_LIMIT,
  GLOBAL_SESSION_PAGE_MAX_LIMIT,
  InvalidGlobalSessionCursorError,
  SessionMovedError,
  SessionProjectMoveError,
  commitSessionProjectMove,
  createSessionIdGenerator,
  listGlobalSessions,
  listKnownSessionProjectRoots,
  getGlobalSession,
  planSessionProjectMove,
  searchGlobalSessions,
  sessionTargetProjectRoot,
  type GlobalSessionPage,
  type Session as CoreSession,
  type SessionProjectMovePlan,
  type SessionSearchHit,
  type SessionSearchPage,
} from "./services/session/index.js";
export * from "./services/workspace-registry/index.js";
export * from "./skill/index.js";
export * from "./utils/index.js";

export {
  collectCleanup,
  createShutdownOptions,
  withinShutdown,
  type CleanupResult,
  type CleanupTaskResult,
  type ShutdownOptions,
} from "./runtime/shutdown.js";
export {
  beginDatabaseShutdown,
  DatabaseShutdownError,
} from "./services/database/index.js";

export { installSystemProxy } from "./utils/network-proxy/index.js";

export type { InstanceSettingsReader } from "./services/settings/reader.js";
