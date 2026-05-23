import { describe, expect, it, vi } from "vitest";
import { McpClient } from "../core/client.js";
import type {
  McpCallToolResult,
  McpSdkClient,
  McpTransport,
} from "../types.js";

interface SdkClientFixture {
  readonly callTool: ReturnType<typeof vi.fn>;
  readonly client: McpSdkClient;
  readonly close: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly listTools: ReturnType<typeof vi.fn>;
  readonly setNotificationHandler: ReturnType<typeof vi.fn>;
}

function createSdkClientFixture(
  overrides: Partial<McpSdkClient> = {},
): SdkClientFixture {
  const callResult: McpCallToolResult = {
    content: [{ text: "called", type: "text" }],
  };
  const callTool = vi.fn(() => Promise.resolve(callResult));
  const close = vi.fn(() => Promise.resolve());
  const connect = vi.fn(() => Promise.resolve());
  const setNotificationHandler = vi.fn();
  const listTools = vi.fn(() =>
    Promise.resolve({
      tools: [
        {
          inputSchema: { type: "object" },
          name: "echo",
        },
      ],
    }),
  );
  const client: McpSdkClient = {
    callTool,
    close,
    connect,
    listTools,
    setNotificationHandler,
    ...overrides,
  };

  return {
    callTool,
    client,
    close,
    connect,
    listTools,
    setNotificationHandler,
  };
}

describe("McpClient", () => {
  it("connects with injected transport and caches discovered tools", async () => {
    const sdk = createSdkClientFixture();
    const transport = {} as McpTransport;
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => transport,
      },
    );

    await client.connect();
    const first = await client.listTools();
    const second = await client.listTools();

    expect(sdk.connect).toHaveBeenCalledWith(transport, { timeout: 5000 });
    expect(sdk.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(sdk.listTools).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(client.getStatus()).toEqual({ status: "connected", toolCount: 1 });
  });

  it("follows pagination cursors while discovering tools", async () => {
    const listTools = vi.fn((params?: { readonly cursor?: string }) =>
      Promise.resolve(
        params?.cursor === "page-2"
          ? {
              tools: [
                {
                  inputSchema: { type: "object" },
                  name: "second",
                },
              ],
            }
          : {
              nextCursor: "page-2",
              tools: [
                {
                  inputSchema: { type: "object" },
                  name: "first",
                },
              ],
            },
      ),
    );
    const sdk = createSdkClientFixture({ listTools });
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );

    await client.connect();

    await expect(client.listTools()).resolves.toEqual([
      { inputSchema: { type: "object" }, name: "first" },
      { inputSchema: { type: "object" }, name: "second" },
    ]);
    expect(listTools).toHaveBeenNthCalledWith(1, undefined, { timeout: 5000 });
    expect(listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: "page-2" },
      { timeout: 5000 },
    );
    expect(client.getStatus()).toEqual({ status: "connected", toolCount: 2 });
  });

  it("captures server metadata exposed during initialization", async () => {
    const sdk = createSdkClientFixture({
      getInstructions: () => "Use read-only operations when possible.",
      getServerCapabilities: () => ({
        prompts: {},
        resources: {},
        tools: { listChanged: true },
      }),
      getServerVersion: () => ({ name: "fixture-server", version: "1.2.3" }),
    });
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );

    await client.connect();

    expect(client.getServerMetadata()).toEqual({
      capabilities: {
        prompts: {},
        resources: {},
        tools: { listChanged: true },
      },
      instructions: "Use read-only operations when possible.",
      serverInfo: { name: "fixture-server", version: "1.2.3" },
    });
  });

  it("invalidates cached tools and notifies listeners on tools/list_changed", async () => {
    let currentToolName = "echo";
    let listChangedHandler: (() => void | Promise<void>) | undefined;
    const listTools = vi.fn(() =>
      Promise.resolve({
        tools: [
          {
            inputSchema: { type: "object" },
            name: currentToolName,
          },
        ],
      }),
    );
    const sdk = createSdkClientFixture({
      listTools,
      setNotificationHandler: vi.fn((_schema, handler) => {
        listChangedHandler = handler as () => void | Promise<void>;
      }),
    });
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );
    const listener = vi.fn();
    client.onToolsChanged(listener);

    await client.connect();
    currentToolName = "updated";
    await listChangedHandler?.();
    const tools = await client.listTools();

    expect(listener).toHaveBeenCalledWith("test");
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(tools).toEqual([
      { inputSchema: { type: "object" }, name: "updated" },
    ]);
  });

  it("records failed status when connection fails", async () => {
    const connect = vi.fn(() => Promise.reject(new Error("spawn failed")));
    const sdk = createSdkClientFixture({ connect });
    const client = new McpClient(
      "bad",
      {
        args: [],
        command: "missing",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );

    await expect(client.connect()).rejects.toThrow("spawn failed");
    expect(client.getStatus()).toMatchObject({
      error: "spawn failed",
      status: "failed",
    });
  });

  it("closes the SDK client when tool discovery fails after connect", async () => {
    const listTools = vi.fn(() => Promise.reject(new Error("list failed")));
    const sdk = createSdkClientFixture({ listTools });
    const client = new McpClient(
      "bad-tools",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );

    await expect(client.connect()).rejects.toThrow("list failed");

    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toMatchObject({
      error: "list failed",
      status: "failed",
    });
  });

  it("calls tools with timeout and abort signal options", async () => {
    const sdk = createSdkClientFixture();
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );
    const signal = new AbortController().signal;

    await client.connect();
    await expect(
      client.callTool(
        { arguments: { value: "hello" }, name: "echo" },
        { signal, timeout: 100 },
      ),
    ).resolves.toMatchObject({
      content: [{ text: "called", type: "text" }],
    });

    expect(sdk.callTool).toHaveBeenCalledWith(
      { arguments: { value: "hello" }, name: "echo" },
      undefined,
      { signal, timeout: 100 },
    );
  });

  it("lists and reads resources when the server supports resources", async () => {
    const listResources = vi.fn((params?: { readonly cursor?: string }) =>
      Promise.resolve(
        params?.cursor === "page-2"
          ? {
              resources: [
                {
                  mimeType: "text/markdown",
                  name: "Guide",
                  uri: "file:///GUIDE.md",
                },
              ],
            }
          : {
              nextCursor: "page-2",
              resources: [
                {
                  mimeType: "text/plain",
                  name: "Readme",
                  uri: "file:///README.md",
                },
              ],
            },
      ),
    );
    const readResource = vi.fn(() =>
      Promise.resolve({
        contents: [
          {
            mimeType: "text/plain",
            text: "hello resource",
            uri: "file:///README.md",
          },
        ],
      }),
    );
    const sdk = createSdkClientFixture({
      getServerCapabilities: () => ({ resources: {} }),
      listResources,
      readResource,
    });
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );

    await client.connect();

    await expect(client.listResources()).resolves.toEqual([
      { mimeType: "text/plain", name: "Readme", uri: "file:///README.md" },
      { mimeType: "text/markdown", name: "Guide", uri: "file:///GUIDE.md" },
    ]);
    await expect(client.readResource("file:///README.md")).resolves.toEqual({
      contents: [
        {
          mimeType: "text/plain",
          text: "hello resource",
          uri: "file:///README.md",
        },
      ],
    });
    expect(readResource).toHaveBeenCalledWith(
      { uri: "file:///README.md" },
      { timeout: 5000 },
    );
    expect(listResources).toHaveBeenNthCalledWith(1, undefined, {
      timeout: 5000,
    });
    expect(listResources).toHaveBeenNthCalledWith(
      2,
      { cursor: "page-2" },
      { timeout: 5000 },
    );
  });

  it("lists and gets prompts when the server supports prompts", async () => {
    const listPrompts = vi.fn((params?: { readonly cursor?: string }) =>
      Promise.resolve(
        params?.cursor === "page-2"
          ? {
              prompts: [
                {
                  description: "Review code",
                  name: "review",
                },
              ],
            }
          : {
              nextCursor: "page-2",
              prompts: [
                {
                  description: "Summarize code",
                  name: "summarize",
                },
              ],
            },
      ),
    );
    const getPrompt = vi.fn(() =>
      Promise.resolve({
        messages: [
          {
            content: { text: "Summarize this", type: "text" },
            role: "user",
          },
        ],
      }),
    );
    const sdk = createSdkClientFixture({
      getPrompt,
      getServerCapabilities: () => ({ prompts: {} }),
      listPrompts,
    });
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => ({}),
      },
    );

    await client.connect();

    await expect(client.listPrompts()).resolves.toEqual([
      { description: "Summarize code", name: "summarize" },
      { description: "Review code", name: "review" },
    ]);
    await expect(
      client.getPrompt("summarize", { topic: "runtime" }),
    ).resolves.toEqual({
      messages: [
        {
          content: { text: "Summarize this", type: "text" },
          role: "user",
        },
      ],
    });
    expect(getPrompt).toHaveBeenCalledWith(
      { arguments: { topic: "runtime" }, name: "summarize" },
      { timeout: 5000 },
    );
    expect(listPrompts).toHaveBeenNthCalledWith(1, undefined, {
      timeout: 5000,
    });
    expect(listPrompts).toHaveBeenNthCalledWith(
      2,
      { cursor: "page-2" },
      { timeout: 5000 },
    );
  });

  it("disconnects the underlying SDK client and updates status", async () => {
    const sdk = createSdkClientFixture();
    const transport = {
      close: vi.fn(() => Promise.resolve()),
    };
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createSdkClient: (): McpSdkClient => sdk.client,
        createTransport: (): McpTransport => transport,
      },
    );

    await client.connect();
    await client.disconnect();

    expect(sdk.close).toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(client.getStatus()).toEqual({ status: "disconnected" });
  });
});
