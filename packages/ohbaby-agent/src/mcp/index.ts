export { McpClient } from "./core/client.js";
export { McpManager } from "./core/manager.js";
export { createTransport } from "./core/transport.js";
export {
  McpConnectionError,
  McpToolDiscoveryError,
  McpToolExecutionError,
} from "./errors.js";
export { adaptMcpTool, transformMcpResult } from "./integration/tool-adapter.js";
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
