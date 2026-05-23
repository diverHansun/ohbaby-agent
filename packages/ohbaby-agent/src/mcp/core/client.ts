import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../config/index.js";
import { McpConnectionError, McpToolDiscoveryError } from "../errors.js";
import type {
  McpCallToolRequest,
  McpCallToolResult,
  McpClientLike,
  McpClientOptions,
  McpClientRequestOptions,
  McpClientStatus,
  McpServerMetadata,
  McpSdkClient,
  McpToolsChangedListener,
  McpToolDefinition,
  McpTransport,
} from "../types.js";
import { createTransport } from "./transport.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultSdkClient(): McpSdkClient {
  return new Client({
    name: "ohbaby-agent",
    version: "0.1.0",
  });
}

export class McpClient implements McpClientLike {
  private sdkClient: McpSdkClient | null = null;
  private status: McpClientStatus = { status: "disconnected" };
  private tools: readonly McpToolDefinition[] | null = null;
  private metadata: McpServerMetadata = { capabilities: {} };
  private readonly toolChangeListeners = new Set<McpToolsChangedListener>();
  private readonly createSdkClient: () => McpSdkClient;
  private readonly createTransport: (config: McpServerConfig) => McpTransport;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    options: McpClientOptions = {},
  ) {
    this.createSdkClient = options.createSdkClient ?? createDefaultSdkClient;
    this.createTransport = options.createTransport ?? createTransport;
    if (!config.enabled) {
      this.status = { status: "disabled" };
    }
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.status = { status: "disabled" };
      return;
    }
    if (this.sdkClient) {
      return;
    }

    const sdkClient = this.createSdkClient();
    const transport = this.createTransport(this.config);
    try {
      await sdkClient.connect(transport, { timeout: this.config.timeout });
      this.sdkClient = sdkClient;
      this.metadata = this.readServerMetadata(sdkClient);
      this.registerToolChangeHandler(sdkClient);
      const tools = await this.refreshTools();
      this.status = { status: "connected", toolCount: tools.length };
    } catch (error) {
      await this.closeAfterFailedConnect(sdkClient);
      this.sdkClient = null;
      this.tools = null;
      if (this.status.status !== "failed") {
        this.status = { error: errorMessage(error), status: "failed" };
      }
      throw new McpConnectionError(this.name, error);
    }
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (this.tools) {
      return this.tools;
    }
    return this.refreshTools();
  }

  async callTool(
    request: McpCallToolRequest,
    options?: McpClientRequestOptions,
  ): Promise<McpCallToolResult> {
    if (!this.sdkClient) {
      throw new Error(`MCP client "${this.name}" is not connected`);
    }
    return this.sdkClient.callTool(request, undefined, options);
  }

  async disconnect(): Promise<void> {
    try {
      await this.sdkClient?.close();
    } finally {
      this.sdkClient = null;
      this.tools = null;
      this.metadata = { capabilities: {} };
      this.status = { status: "disconnected" };
    }
  }

  getStatus(): McpClientStatus {
    return this.status;
  }

  getServerMetadata(): McpServerMetadata {
    return this.metadata;
  }

  onToolsChanged(listener: McpToolsChangedListener): () => void {
    this.toolChangeListeners.add(listener);
    return () => {
      this.toolChangeListeners.delete(listener);
    };
  }

  private readServerMetadata(sdkClient: McpSdkClient): McpServerMetadata {
    return {
      capabilities: sdkClient.getServerCapabilities?.() ?? {},
      instructions: sdkClient.getInstructions?.(),
      serverInfo: sdkClient.getServerVersion?.(),
    };
  }

  private registerToolChangeHandler(sdkClient: McpSdkClient): void {
    sdkClient.setNotificationHandler?.(
      ToolListChangedNotificationSchema,
      async () => {
        this.tools = null;
        await this.notifyToolsChanged();
      },
    );
  }

  private async notifyToolsChanged(): Promise<void> {
    await Promise.all(
      Array.from(this.toolChangeListeners).map((listener) =>
        Promise.resolve(listener(this.name)),
      ),
    );
  }

  private async refreshTools(): Promise<readonly McpToolDefinition[]> {
    if (!this.sdkClient) {
      throw new Error(`MCP client "${this.name}" is not connected`);
    }
    try {
      const result = await this.sdkClient.listTools(undefined, {
        timeout: this.config.timeout,
      });
      this.tools = result.tools;
      this.status = { status: "connected", toolCount: result.tools.length };
      return result.tools;
    } catch (error) {
      this.status = { error: errorMessage(error), status: "failed" };
      throw new McpToolDiscoveryError(this.name, error);
    }
  }

  private async closeAfterFailedConnect(sdkClient: McpSdkClient): Promise<void> {
    try {
      await sdkClient.close();
    } catch {
      // Preserve the original connection/discovery failure for callers.
    }
  }
}
