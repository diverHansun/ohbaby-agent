import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../config/index.js";
import { getAgentPackageVersion } from "../../package-version.js";
import { McpConnectionError, McpToolDiscoveryError } from "../errors.js";
import type {
  McpCallToolRequest,
  McpCallToolResult,
  McpClientLike,
  McpClientOptions,
  McpClientRequestOptions,
  McpClientStatus,
  McpGetPromptResult,
  McpPromptDefinition,
  McpReadResourceResult,
  McpResourceDefinition,
  McpServerMetadata,
  McpSdkClient,
  McpToolsChangedListener,
  McpToolDefinition,
  McpTransport,
} from "../types.js";
import { createTransport } from "./transport.js";

interface McpPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultSdkClient(): McpSdkClient {
  return new Client({
    name: "ohbaby-agent",
    version: getAgentPackageVersion(),
  });
}

function listParams(
  cursor: string | undefined,
): { readonly cursor: string } | undefined {
  return cursor ? { cursor } : undefined;
}

async function collectPaginated<T>(
  fetchPage: (cursor: string | undefined) => Promise<McpPage<T>>,
): Promise<readonly T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    const nextCursor = page.nextCursor;
    if (!nextCursor) {
      return items;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(`MCP pagination cursor repeated: ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
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

  async listResources(): Promise<readonly McpResourceDefinition[]> {
    if (!this.metadata.capabilities.resources) {
      return [];
    }
    if (!this.sdkClient) {
      throw new Error(`MCP client "${this.name}" is not connected`);
    }
    if (!this.sdkClient.listResources) {
      return [];
    }
    const sdkClient = this.sdkClient;
    return collectPaginated(async (cursor) => {
      const result = await sdkClient.listResources?.(listParams(cursor), {
        timeout: this.config.timeout,
      });
      return {
        items: result?.resources ?? [],
        nextCursor: result?.nextCursor,
      };
    });
  }

  async readResource(uri: string): Promise<McpReadResourceResult> {
    if (!this.metadata.capabilities.resources) {
      throw new Error(`MCP server "${this.name}" does not support resources`);
    }
    if (!this.sdkClient) {
      throw new Error(`MCP client "${this.name}" is not connected`);
    }
    if (!this.sdkClient.readResource) {
      throw new Error(`MCP client "${this.name}" cannot read resources`);
    }
    return this.sdkClient.readResource(
      { uri },
      { timeout: this.config.timeout },
    );
  }

  async listPrompts(): Promise<readonly McpPromptDefinition[]> {
    if (!this.metadata.capabilities.prompts) {
      return [];
    }
    if (!this.sdkClient) {
      throw new Error(`MCP client "${this.name}" is not connected`);
    }
    if (!this.sdkClient.listPrompts) {
      return [];
    }
    const sdkClient = this.sdkClient;
    return collectPaginated(async (cursor) => {
      const result = await sdkClient.listPrompts?.(listParams(cursor), {
        timeout: this.config.timeout,
      });
      return {
        items: result?.prompts ?? [],
        nextCursor: result?.nextCursor,
      };
    });
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<McpGetPromptResult> {
    if (!this.metadata.capabilities.prompts) {
      throw new Error(`MCP server "${this.name}" does not support prompts`);
    }
    if (!this.sdkClient) {
      throw new Error(`MCP client "${this.name}" is not connected`);
    }
    if (!this.sdkClient.getPrompt) {
      throw new Error(`MCP client "${this.name}" cannot get prompts`);
    }
    return this.sdkClient.getPrompt(
      { arguments: args, name },
      { timeout: this.config.timeout },
    );
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
      const sdkClient = this.sdkClient;
      const tools = await collectPaginated(async (cursor) => {
        const result = await sdkClient.listTools(listParams(cursor), {
          timeout: this.config.timeout,
        });
        return {
          items: result.tools,
          nextCursor: result.nextCursor,
        };
      });
      this.tools = tools;
      this.status = { status: "connected", toolCount: tools.length };
      return tools;
    } catch (error) {
      this.status = { error: errorMessage(error), status: "failed" };
      throw new McpToolDiscoveryError(this.name, error);
    }
  }

  private async closeAfterFailedConnect(
    sdkClient: McpSdkClient,
  ): Promise<void> {
    try {
      await sdkClient.close();
    } catch {
      // Preserve the original connection/discovery failure for callers.
    }
  }
}
