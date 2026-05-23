export { McpClient } from "./core/client.js";
export { McpManager } from "./core/manager.js";
export { createTransport } from "./core/transport.js";
export {
  McpConnectionError,
  McpToolDiscoveryError,
  McpToolExecutionError,
} from "./errors.js";
export { adaptMcpTool, transformMcpResult } from "./integration/tool-adapter.js";

export type {
  McpAudioContent,
  McpCallToolRequest,
  McpCallToolResult,
  McpClientLike,
  McpClientOptions,
  McpClientRequestOptions,
  McpClientStatus,
  McpContentBlock,
  McpImageContent,
  McpManagerChangeListener,
  McpManagerOptions,
  McpResourceContent,
  McpResourceLinkContent,
  McpSdkClient,
  McpServerCapabilities,
  McpServerInfo,
  McpServerMetadata,
  McpTextContent,
  McpTool,
  McpToolDefinition,
  McpToolsChangedListener,
  McpTransport,
  ToolAnnotations,
} from "./types.js";
