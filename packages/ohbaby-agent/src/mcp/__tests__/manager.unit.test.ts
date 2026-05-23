import { describe, expect, it, vi } from "vitest";
import type { McpServersConfig } from "../../config/index.js";
import { McpManager } from "../core/manager.js";
import type {
  McpCallToolResult,
  McpClientLike,
  McpClientStatus,
  McpGetPromptResult,
  McpPromptDefinition,
  McpReadResourceResult,
  McpResourceDefinition,
  McpServerMetadata,
  McpToolDefinition,
} from "../types.js";

function createFakeClient(input: {
  readonly name: string;
  readonly tools?: readonly McpToolDefinition[];
  readonly connectError?: Error;
  readonly result?: McpCallToolResult;
}): McpClientLike {
  let status: McpClientStatus = { status: "disconnected" };
  const tools = input.tools ?? [
    {
      inputSchema: { type: "object" },
      name: "echo",
    },
  ];

  return {
    name: input.name,
    config: {
      args: [],
      command: "mock",
      enabled: true,
      timeout: 5000,
      trust: false,
      type: "stdio",
    },
    callTool(): Promise<McpCallToolResult> {
      return Promise.resolve(
        input.result ?? {
          content: [{ text: `${input.name} result`, type: "text" }],
        },
      );
    },
    connect(): Promise<void> {
      if (input.connectError) {
        status = {
          error: input.connectError.message,
          status: "failed",
        };
        return Promise.reject(input.connectError);
      }
      status = { status: "connected", toolCount: tools.length };
      return Promise.resolve();
    },
    disconnect: vi.fn(() => {
      status = { status: "disconnected" };
      return Promise.resolve();
    }),
    getStatus(): McpClientStatus {
      return status;
    },
    getServerMetadata(): McpServerMetadata {
      return { capabilities: {} };
    },
    getPrompt(): Promise<McpGetPromptResult> {
      return Promise.reject(new Error("prompts not configured"));
    },
    listTools(): Promise<readonly McpToolDefinition[]> {
      return Promise.resolve(tools);
    },
    listPrompts(): Promise<readonly McpPromptDefinition[]> {
      return Promise.resolve([]);
    },
    listResources(): Promise<readonly McpResourceDefinition[]> {
      return Promise.resolve([]);
    },
    readResource(): Promise<McpReadResourceResult> {
      return Promise.reject(new Error("resources not configured"));
    },
  };
}

function createChangingFakeClient(input: {
  readonly name: string;
  readonly initialTools: readonly McpToolDefinition[];
}): McpClientLike & {
  emitToolsChanged(): void;
  setTools(tools: readonly McpToolDefinition[]): void;
} {
  let tools = input.initialTools;
  const listeners = new Set<(serverName: string) => void | Promise<void>>();
  const client = createFakeClient({ name: input.name, tools });
  return {
    ...client,
    emitToolsChanged(): void {
      for (const listener of listeners) {
        void listener(input.name);
      }
    },
    listTools(): Promise<readonly McpToolDefinition[]> {
      return Promise.resolve(tools);
    },
    onToolsChanged(listener: (serverName: string) => void | Promise<void>) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTools(nextTools: readonly McpToolDefinition[]): void {
      tools = nextTools;
    },
  };
}

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("McpManager", () => {
  it("lazy loads config only on first tool access and reuses the init promise", async () => {
    const loadConfig = vi.fn(
      (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            first: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio" as const,
            },
          },
        }),
    );
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => createFakeClient({ name }),
      loadConfig,
    });

    expect(loadConfig).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      manager.getAllTools(),
      manager.getAllTools(),
    ]);

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].name).toBe("mcp_s5_first_t4_echo");
  });

  it("filters tools by includeTools and excludeTools before adapting", async () => {
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike =>
        createFakeClient({
          name,
          tools: [
            { inputSchema: { type: "object" }, name: "read" },
            { inputSchema: { type: "object" }, name: "write" },
            { inputSchema: { type: "object" }, name: "delete" },
          ],
        }),
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            fs: {
              args: [],
              command: "mock",
              enabled: true,
              excludeTools: ["delete"],
              includeTools: ["read"],
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    await expect(manager.getAllTools()).resolves.toEqual([
      expect.objectContaining({
        mcpToolName: "read",
        name: "mcp_s2_fs_t4_read",
      }),
    ]);
  });

  it("isolates failing servers and reports status for disabled and failed entries", async () => {
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike =>
        createFakeClient({
          connectError: name === "bad" ? new Error("boom") : undefined,
          name,
        }),
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            bad: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
            disabled: {
              args: [],
              command: "mock",
              enabled: false,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
            good: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    await expect(manager.getAllTools()).resolves.toEqual([
      expect.objectContaining({ name: "mcp_s4_good_t4_echo" }),
    ]);
    await expect(manager.getStatus()).resolves.toMatchObject({
      bad: { error: "boom", status: "failed" },
      disabled: { status: "disabled" },
      good: { status: "connected", toolCount: 1 },
    });
  });

  it("executes tools through the selected server client", async () => {
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => createFakeClient({ name }),
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            fs: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    await expect(
      manager.executeTool("fs", "echo", { value: "hello" }),
    ).resolves.toMatchObject({
      content: [{ text: "fs result", type: "text" }],
    });
    await expect(manager.executeTool("missing", "echo", {})).rejects.toThrow(
      'MCP server "missing" not found',
    );
  });

  it("invalidates cached tools and notifies listeners when a client changes tools", async () => {
    const client = createChangingFakeClient({
      initialTools: [{ inputSchema: { type: "object" }, name: "echo" }],
      name: "fs",
    });
    const manager = new McpManager("workspace-a", {
      createClient: (): McpClientLike => client,
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            fs: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });
    const listener = vi.fn();
    manager.onChange(listener);

    await expect(manager.getAllTools()).resolves.toEqual([
      expect.objectContaining({ name: "mcp_s2_fs_t4_echo" }),
    ]);

    client.setTools([{ inputSchema: { type: "object" }, name: "updated" }]);
    client.emitToolsChanged();

    expect(listener).toHaveBeenCalledTimes(1);
    await expect(manager.getAllTools()).resolves.toEqual([
      expect.objectContaining({ name: "mcp_s2_fs_t7_updated" }),
    ]);
  });

  it("lists resources and prompts with their source server names", async () => {
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => ({
        ...createFakeClient({ name }),
        getPrompt(promptName: string): Promise<McpGetPromptResult> {
          return Promise.resolve({
            messages: [
              {
                content: { text: `prompt ${promptName}`, type: "text" },
                role: "user",
              },
            ],
          });
        },
        getServerMetadata(): McpServerMetadata {
          return { capabilities: { prompts: {}, resources: {} } };
        },
        listPrompts(): Promise<readonly McpPromptDefinition[]> {
          return Promise.resolve([
            { description: "Prompt", name: "summarize" },
          ]);
        },
        listResources(): Promise<readonly McpResourceDefinition[]> {
          return Promise.resolve([
            {
              mimeType: "text/plain",
              name: "Readme",
              uri: "file:///README.md",
            },
          ]);
        },
        readResource(uri: string): Promise<McpReadResourceResult> {
          return Promise.resolve({
            contents: [{ text: `resource ${uri}`, type: "text", uri }],
          });
        },
      }),
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            fs: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    await expect(manager.listResources()).resolves.toEqual([
      {
        mimeType: "text/plain",
        name: "Readme",
        serverName: "fs",
        uri: "file:///README.md",
      },
    ]);
    await expect(manager.listPrompts()).resolves.toEqual([
      { description: "Prompt", name: "summarize", serverName: "fs" },
    ]);
    await expect(
      manager.readResource("fs", "file:///README.md"),
    ).resolves.toEqual({
      contents: [
        {
          text: "resource file:///README.md",
          type: "text",
          uri: "file:///README.md",
        },
      ],
    });
    await expect(manager.getPrompt("fs", "summarize")).resolves.toEqual({
      messages: [
        { content: { text: "prompt summarize", type: "text" }, role: "user" },
      ],
    });
  });

  it("isolates resource and prompt discovery failures per server", async () => {
    const onError = vi.fn();
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => ({
        ...createFakeClient({ name }),
        listPrompts(): Promise<readonly McpPromptDefinition[]> {
          if (name === "bad") {
            return Promise.reject(new Error("prompt boom"));
          }
          return Promise.resolve([{ name: "summarize" }]);
        },
        listResources(): Promise<readonly McpResourceDefinition[]> {
          if (name === "bad") {
            return Promise.reject(new Error("resource boom"));
          }
          return Promise.resolve([{ uri: "file:///README.md" }]);
        },
      }),
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            bad: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
            good: {
              args: [],
              command: "mock",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
      onError,
    });

    await expect(manager.listResources()).resolves.toEqual([
      { serverName: "good", uri: "file:///README.md" },
    ]);
    await expect(manager.listPrompts()).resolves.toEqual([
      { name: "summarize", serverName: "good" },
    ]);
    await expect(manager.getStatus()).resolves.toMatchObject({
      bad: { error: "prompt boom", status: "failed" },
      good: { status: "connected", toolCount: 1 },
    });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("registers plugin-provided servers without overriding manual config", async () => {
    const seenConfigs: string[] = [];
    const manager = new McpManager("workspace-a", {
      createClient: (name: string, config): McpClientLike => {
        seenConfigs.push(
          `${name}:${config.type === "stdio" ? config.command : "remote"}`,
        );
        return createFakeClient({ name });
      },
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            shared: {
              args: [],
              command: "manual",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    await manager.registerPluginServers("example-plugin", {
      pluginOnly: {
        args: [],
        command: "plugin-only",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      shared: {
        args: [],
        command: "plugin-shared",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
    });

    await expect(manager.getAllTools()).resolves.toEqual([
      expect.objectContaining({ name: "mcp_s6_shared_t4_echo" }),
      expect.objectContaining({ name: "mcp_s10_pluginOnly_t4_echo" }),
    ]);
    expect(seenConfigs).toEqual(["shared:manual", "pluginOnly:plugin-only"]);
  });

  it("deregisters plugin-provided servers and notifies listeners", async () => {
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => createFakeClient({ name }),
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {},
        }),
    });
    const listener = vi.fn();
    manager.onChange(listener);
    await manager.registerPluginServers("example-plugin", {
      pluginOnly: {
        args: [],
        command: "plugin-only",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
    });

    await expect(manager.getAllTools()).resolves.toEqual([
      expect.objectContaining({ name: "mcp_s10_pluginOnly_t4_echo" }),
    ]);

    await manager.deregisterPlugin("example-plugin");

    await expect(manager.getAllTools()).resolves.toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("waits for stale clients to disconnect before reconnecting plugin config changes", async () => {
    const disconnectGate = createDeferred();
    const disconnect = vi.fn(() => disconnectGate.promise);
    const createdClients: string[] = [];
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => {
        createdClients.push(name);
        return {
          ...createFakeClient({ name }),
          disconnect,
        };
      },
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            manual: {
              args: [],
              command: "manual",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    await expect(manager.getAllTools()).resolves.toHaveLength(1);

    const registration = manager.registerPluginServers("example-plugin", {
      pluginOnly: {
        args: [],
        command: "plugin-only",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
    });
    const refreshedTools = manager.getAllTools();
    await Promise.resolve();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(createdClients).toEqual(["manual"]);

    disconnectGate.resolve();
    await registration;
    await expect(refreshedTools).resolves.toHaveLength(2);
    expect(createdClients).toEqual(["manual", "manual", "pluginOnly"]);
  });

  it("waits for in-flight initialization before applying plugin config changes", async () => {
    const connectGate = createDeferred();
    const disconnect = vi.fn(() => Promise.resolve());
    const createdClients: string[] = [];
    const manager = new McpManager("workspace-a", {
      createClient: (name: string): McpClientLike => {
        createdClients.push(name);
        const creationIndex = createdClients.length;
        let status: McpClientStatus = { status: "disconnected" };
        return {
          name,
          config: {
            args: [],
            command: "mock",
            enabled: true,
            timeout: 5000,
            trust: false,
            type: "stdio",
          },
          callTool(): Promise<McpCallToolResult> {
            return Promise.resolve({ content: [] });
          },
          async connect(): Promise<void> {
            if (name === "manual" && creationIndex === 1) {
              await connectGate.promise;
            }
            status = { status: "connected", toolCount: 1 };
          },
          disconnect,
          getStatus(): McpClientStatus {
            return status;
          },
          listTools(): Promise<readonly McpToolDefinition[]> {
            return Promise.resolve([
              { inputSchema: { type: "object" }, name: "echo" },
            ]);
          },
        };
      },
      loadConfig: (): Promise<McpServersConfig> =>
        Promise.resolve({
          mcpServers: {
            manual: {
              args: [],
              command: "manual",
              enabled: true,
              timeout: 5000,
              trust: false,
              type: "stdio",
            },
          },
        }),
    });

    const initialTools = manager.getAllTools();
    await Promise.resolve();

    const registration = manager.registerPluginServers("example-plugin", {
      pluginOnly: {
        args: [],
        command: "plugin-only",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
    });
    const refreshedTools = manager.getAllTools();
    await Promise.resolve();

    expect(createdClients).toEqual(["manual"]);

    connectGate.resolve();
    await expect(initialTools).resolves.toEqual(expect.any(Array));
    await registration;
    await expect(refreshedTools).resolves.toHaveLength(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(createdClients).toEqual(["manual", "manual", "pluginOnly"]);
  });

  it("reuses singleton instances by workspace and disposes them for tests", async () => {
    McpManager.resetInstancesForTest();
    const first = McpManager.getInstance("workspace-a");
    const second = McpManager.getInstance("workspace-a");
    const other = McpManager.getInstance("workspace-b");

    expect(first).toBe(second);
    expect(first).not.toBe(other);

    await McpManager.disposeAll();
    expect(McpManager.getInstance("workspace-a")).not.toBe(first);
  });
});
