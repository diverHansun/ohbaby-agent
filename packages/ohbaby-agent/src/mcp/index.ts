export { McpClient } from "./core/client.js";
export { McpManager } from "./core/manager.js";
export { createTransport } from "./core/transport.js";
export {
  McpConnectionError,
  McpToolDiscoveryError,
  McpToolExecutionError,
} from "./errors.js";
export {
  adaptMcpTool,
  transformMcpResult,
} from "./integration/tool-adapter.js";
export {
  admitMcpTool,
  admitMcpTools,
  createSelectToolsTool,
  McpToolMenu,
  MAX_MCP_TOOL_NAME_CHARS,
  MAX_MCP_TOOL_SCHEMA_DEPTH,
  MAX_MCP_TOOLS_PER_SELECTION,
  MAX_MCP_TOOLS_PER_SESSION,
} from "./integration/dynamic-tool-menu.js";
export type {
  McpToolAdmissionResult,
  McpToolMenuScope,
  McpToolRejection,
  McpToolRejectionReason,
  McpToolSelection,
} from "./integration/dynamic-tool-menu.js";
export {
  createMcpPromptTool,
  createMcpResourceTool,
} from "./integration/resource-prompt-tools.js";

export type {
  McpAudioContent,
  McpCallToolRequest,
  McpCallToolResult,
  McpClientLike,
  McpClientOptions,
  McpClientRequestOptions,
  McpClientStatus,
  McpContentBlock,
  McpGetPromptResult,
  McpImageContent,
  McpManagerChangeListener,
  McpManagerOptions,
  McpPromptArgument,
  McpPromptDefinition,
  McpPromptMessage,
  McpPluginServerContribution,
  McpReadResourceResult,
  McpResourceContent,
  McpResourceDefinition,
  McpResourceLinkContent,
  McpSdkClient,
  McpServerCapabilities,
  McpServerInfo,
  McpServerMetadata,
  McpServerPromptDefinition,
  McpServerResourceDefinition,
  McpTextContent,
  McpTool,
  McpToolDefinition,
  McpToolsChangedListener,
  McpTransport,
  ToolAnnotations,
} from "./types.js";
