import type { McpServerConfig, McpServersConfig } from "../../config/index.js";
import { loadMcpConfig } from "../../config/index.js";
import { McpClient } from "./client.js";
import { adaptMcpTool } from "../integration/tool-adapter.js";
import type {
  McpCallToolResult,
  McpClientLike,
  McpClientStatus,
  McpManagerChangeListener,
  McpManagerOptions,
  McpTool,
  McpToolDefinition,
} from "../types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldIncludeTool(
  tool: McpToolDefinition,
  config: McpServerConfig,
): boolean {
  if (config.includeTools && !config.includeTools.includes(tool.name)) {
    return false;
  }
  if (config.excludeTools?.includes(tool.name)) {
    return false;
  }
  return true;
}

export class McpManager {
  private static readonly instances = new Map<string, McpManager>();

  private readonly clients = new Map<string, McpClientLike>();
  private readonly clientToolUnsubscribers = new Map<string, () => void>();
  private readonly serverConfigs = new Map<string, McpServerConfig>();
  private readonly statuses = new Map<string, McpClientStatus>();
  private readonly listeners = new Set<McpManagerChangeListener>();
  private readonly loadConfig: (
    workspaceId: string,
  ) => Promise<McpServersConfig>;
  private readonly createClient: (
    serverName: string,
    config: McpServerConfig,
  ) => McpClientLike;
  private readonly onError: (error: unknown) => void;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private tools: readonly McpTool[] | null = null;

  constructor(
    readonly workspaceId: string,
    options: McpManagerOptions = {},
  ) {
    this.loadConfig =
      options.loadConfig ??
      ((projectDirectory: string): Promise<McpServersConfig> =>
        loadMcpConfig({ projectDirectory }));
    this.createClient =
      options.createClient ??
      ((serverName: string, config: McpServerConfig): McpClientLike =>
        new McpClient(serverName, config));
    this.onError = options.onError ?? ((): void => undefined);
  }

  static getInstance(
    workspaceId: string,
    options: McpManagerOptions = {},
  ): McpManager {
    const existing = this.instances.get(workspaceId);
    if (existing) {
      return existing;
    }
    const manager = new McpManager(workspaceId, options);
    this.instances.set(workspaceId, manager);
    return manager;
  }

  static resetInstancesForTest(): void {
    this.instances.clear();
  }

  static async disposeAll(): Promise<void> {
    const managers = Array.from(this.instances.values());
    await Promise.all(managers.map((manager) => manager.dispose()));
    this.instances.clear();
  }

  async getAllTools(): Promise<readonly McpTool[]> {
    await this.ensureInitialized();
    if (this.tools) {
      return this.tools;
    }

    const tools: McpTool[] = [];
    for (const [serverName, client] of this.clients) {
      try {
        const config = this.serverConfigs.get(serverName) ?? client.config;
        const definitions = await client.listTools();
        for (const tool of definitions) {
          if (shouldIncludeTool(tool, config)) {
            tools.push(adaptMcpTool(tool, client));
          }
        }
        this.statuses.set(serverName, client.getStatus());
      } catch (error) {
        this.statuses.set(serverName, {
          error: errorMessage(error),
          status: "failed",
        });
        this.onError(error);
      }
    }

    this.tools = tools;
    return tools;
  }

  async executeTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    await this.ensureInitialized();
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    return client.callTool(
      {
        arguments: params,
        name: toolName,
      },
      { timeout: client.config.timeout },
    );
  }

  async getStatus(): Promise<Record<string, McpClientStatus>> {
    await this.ensureInitialized();
    for (const [serverName, client] of this.clients) {
      this.statuses.set(serverName, client.getStatus());
    }
    return Object.fromEntries(this.statuses);
  }

  onChange(listener: McpManagerChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.clientToolUnsubscribers.values()) {
      unsubscribe();
    }
    this.clientToolUnsubscribers.clear();
    await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.disconnect()),
    );
    this.clients.clear();
    this.serverConfigs.clear();
    this.statuses.clear();
    this.tools = null;
    this.initialized = false;
    this.initPromise = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    try {
      await this.initPromise;
      this.initialized = true;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    let config;
    try {
      config = await this.loadConfig(this.workspaceId);
    } catch (error) {
      this.onError(error);
      return;
    }

    const tasks = Object.entries(config.mcpServers).map(
      async ([serverName, serverConfig]) => {
        this.serverConfigs.set(serverName, serverConfig);
        if (!serverConfig.enabled) {
          this.statuses.set(serverName, { status: "disabled" });
          return;
        }

        const client = this.createClient(serverName, serverConfig);
        const unsubscribe = client.onToolsChanged?.(() => {
          this.handleClientToolsChanged(serverName, client);
        });
        if (unsubscribe) {
          this.clientToolUnsubscribers.set(serverName, unsubscribe);
        }
        try {
          await client.connect();
          this.clients.set(serverName, client);
          this.statuses.set(serverName, client.getStatus());
        } catch (error) {
          unsubscribe?.();
          this.clientToolUnsubscribers.delete(serverName);
          this.statuses.set(serverName, {
            error: errorMessage(error),
            status: "failed",
          });
          this.onError(error);
        }
      },
    );

    await Promise.all(tasks);
  }

  private handleClientToolsChanged(
    serverName: string,
    client: McpClientLike,
  ): void {
    if (this.clients.get(serverName) !== client) {
      return;
    }
    this.tools = null;
    this.statuses.set(serverName, client.getStatus());
    this.notifyChanged();
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) {
      void listener();
    }
  }
}
