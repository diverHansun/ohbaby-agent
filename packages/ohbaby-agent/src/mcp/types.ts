import type { McpServerConfig, McpServersConfig } from "../config/index.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";

export type McpClientStatus =
  | { readonly status: "connected"; readonly toolCount: number }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "disconnected" }
  | { readonly status: "disabled" };

export interface McpServerCapabilities {
  readonly tools?: {
    readonly listChanged?: boolean;
    readonly [key: string]: unknown;
  };
  readonly resources?: {
    readonly subscribe?: boolean;
    readonly listChanged?: boolean;
    readonly [key: string]: unknown;
  };
  readonly prompts?: {
    readonly listChanged?: boolean;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version?: string;
}

export interface McpServerMetadata {
  readonly capabilities: McpServerCapabilities;
  readonly serverInfo?: McpServerInfo;
  readonly instructions?: string;
}

export type McpToolsChangedListener = (
  serverName: string,
) => void | Promise<void>;

export type McpManagerChangeListener = () => void | Promise<void>;

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ToolAnnotations;
}

export interface McpCallToolRequest {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface McpAudioContent {
  readonly type: "audio";
  readonly data: string;
  readonly mimeType: string;
}

export interface McpResourceContent {
  readonly type: "resource";
  readonly resource: {
    readonly uri: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
  };
}

export interface McpResourceLinkContent {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export type McpContentBlock =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpResourceContent
  | McpResourceLinkContent;

export interface McpCallToolResult {
  readonly content?: readonly McpContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly toolResult?: unknown;
  readonly isError?: boolean;
}

export interface McpClientRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

export interface McpTransport {
  close?(): Promise<void>;
  start?(): Promise<void>;
}

export interface McpSdkClient {
  connect(
    transport: McpTransport,
    options?: McpClientRequestOptions,
  ): Promise<void>;
  listTools(
    params?: unknown,
    options?: McpClientRequestOptions,
  ): Promise<{ readonly tools: readonly McpToolDefinition[] }>;
  callTool(
    request: McpCallToolRequest,
    resultSchema?: unknown,
    options?: McpClientRequestOptions,
  ): Promise<McpCallToolResult>;
  getInstructions?(): string | undefined;
  getServerCapabilities?(): McpServerCapabilities | undefined;
  getServerVersion?(): McpServerInfo | undefined;
  setNotificationHandler?(
    schema: unknown,
    handler: (notification: unknown) => void | Promise<void>,
  ): void;
  close(): Promise<void>;
}

export interface McpClientLike {
  readonly name: string;
  readonly config: McpServerConfig;
  connect(): Promise<void>;
  listTools(): Promise<readonly McpToolDefinition[]>;
  callTool(
    request: McpCallToolRequest,
    options?: McpClientRequestOptions,
  ): Promise<McpCallToolResult>;
  disconnect(): Promise<void>;
  getStatus(): McpClientStatus;
  getServerMetadata?(): McpServerMetadata;
  onToolsChanged?(listener: McpToolsChangedListener): () => void;
}

export interface McpClientOptions {
  readonly createSdkClient?: () => McpSdkClient;
  readonly createTransport?: (config: McpServerConfig) => McpTransport;
}

export interface McpManagerOptions {
  readonly loadConfig?: (workspaceId: string) => Promise<McpServersConfig>;
  readonly createClient?: (
    serverName: string,
    config: McpServerConfig,
  ) => McpClientLike;
  readonly onError?: (error: unknown) => void;
}

export interface McpTool extends Tool {
  readonly mcpServer: string;
  readonly mcpToolName: string;
  readonly isTrusted: boolean;
  readonly mcpAnnotations?: ToolAnnotations;
  execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
