import { describe, expect, it, vi } from "vitest";
import type {
  McpCallToolResult,
  McpClientLike,
  McpToolDefinition,
} from "../types.js";
import { adaptMcpTool, transformMcpResult } from "../integration/tool-adapter.js";

interface MockClientFixture {
  readonly callTool: ReturnType<typeof vi.fn>;
  readonly client: McpClientLike;
}

function createMockClient(name = "server-name"): MockClientFixture {
  const callResult: McpCallToolResult = {
    content: [{ text: "tool result", type: "text" }],
  };
  const callTool = vi.fn(() => Promise.resolve(callResult));
  const client: McpClientLike = {
    name,
    config: {
      args: [],
      command: "mock",
      enabled: true,
      timeout: 5000,
      trust: true,
      type: "stdio",
    },
    callTool,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => ({ status: "connected" as const, toolCount: 1 })),
    listTools: vi.fn(),
  };
  return { callTool, client };
}

describe("adaptMcpTool", () => {
  it("adapts MCP tool definitions to scheduler tools with metadata", () => {
    const { client } = createMockClient();
    const mcpTool: McpToolDefinition = {
      annotations: { readOnlyHint: true },
      description: "Read data",
      inputSchema: {
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      name: "read.file",
    };

    const tool = adaptMcpTool(mcpTool, client);

    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true },
      category: "readonly",
      description: "Read data",
      isTrusted: true,
      mcpServer: "server-name",
      mcpToolName: "read.file",
      name: "mcp_s11_server-name_t13_read_x2e_file",
      parametersJsonSchema: mcpTool.inputSchema,
      source: "mcp",
    });
  });

  it("defaults MCP tools without readOnlyHint to write category", () => {
    const tool = adaptMcpTool(
      {
        inputSchema: { type: "object" },
        name: "mutate",
      },
      createMockClient().client,
    );

    expect(tool.category).toBe("write");
  });

  it("uses collision-resistant local names for MCP names with punctuation", () => {
    const { client } = createMockClient();
    const dotted = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "read.file" },
      client,
    );
    const underscored = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "read_file" },
      client,
    );

    expect(dotted.name).toBe("mcp_s11_server-name_t13_read_x2e_file");
    expect(underscored.name).toBe("mcp_s11_server-name_t10_read__file");
    expect(dotted.name).not.toBe(underscored.name);
  });

  it("uses collision-resistant local names across server and tool boundaries", () => {
    const serverWithUnderscore = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "b" },
      createMockClient("a_").client,
    );
    const toolWithUnderscore = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "_b" },
      createMockClient("a").client,
    );

    expect(serverWithUnderscore.name).toBe("mcp_s3_a___t1_b");
    expect(toolWithUnderscore.name).toBe("mcp_s1_a_t3___b");
    expect(serverWithUnderscore.name).not.toBe(toolWithUnderscore.name);
  });

  it("preserves whitespace and empty names in collision-resistant local names", () => {
    const plain = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "read" },
      createMockClient("server").client,
    );
    const padded = adaptMcpTool(
      { inputSchema: { type: "object" }, name: " read " },
      createMockClient("server").client,
    );
    const empty = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "" },
      createMockClient("server").client,
    );
    const unnamed = adaptMcpTool(
      { inputSchema: { type: "object" }, name: "unnamed" },
      createMockClient("server").client,
    );

    expect(plain.name).toBe("mcp_s6_server_t4_read");
    expect(padded.name).toBe("mcp_s6_server_t14__x20_read_x20_");
    expect(empty.name).toBe("mcp_s6_server_t0_");
    expect(unnamed.name).toBe("mcp_s6_server_t7_unnamed");
    expect(new Set([plain.name, padded.name, empty.name, unnamed.name]).size).toBe(4);
  });

  it("forwards execution to the original MCP tool name", async () => {
    const { callTool, client } = createMockClient();
    const tool = adaptMcpTool(
      {
        inputSchema: { type: "object" },
        name: "search",
      },
      client,
    );
    const signal = new AbortController().signal;

    const result = await tool.execute(
      { query: "ohbaby" },
      {
        callId: "call-1",
        messageId: "message-1",
        sessionId: "session-1",
        signal,
      },
    );

    expect(callTool).toHaveBeenCalledWith(
      { arguments: { query: "ohbaby" }, name: "search" },
      { signal, timeout: 5000 },
    );
    expect(result).toMatchObject({
      metadata: {
        contentTypes: ["text"],
        server: "server-name",
        source: "mcp",
        tool: "search",
      },
      output: "tool result",
    });
  });
});

describe("transformMcpResult", () => {
  it("transforms text, image, and resource content into scheduler output", () => {
    const output = transformMcpResult(
      {
        content: [
          { text: "Line 1", type: "text" },
          { data: "abc123", mimeType: "image/png", type: "image" },
          {
            resource: {
              text: "File text",
              uri: "file:///tmp/example.txt",
            },
            type: "resource",
          },
        ],
      },
      { serverName: "server", toolName: "mixed" },
    );

    expect(output.output).toContain("Line 1");
    expect(output.output).toContain("![Image](data:image/png;base64,abc123)");
    expect(output.output).toContain("[Resource: file:///tmp/example.txt]");
    expect(output.output).toContain("File text");
    expect(output.metadata).toMatchObject({
      contentTypes: ["text", "image", "resource"],
      hasImage: true,
      server: "server",
      source: "mcp",
      tool: "mixed",
    });
  });

  it("marks MCP error results in metadata for callers that inspect raw transforms", () => {
    expect(
      transformMcpResult(
        {
          content: [{ text: "MCP failed", type: "text" }],
          isError: true,
        },
        { serverName: "server", toolName: "bad" },
      ),
    ).toMatchObject({
      metadata: { isError: true, source: "mcp" },
      output: "MCP failed",
    });
  });

  it("keeps structuredContent available for context projection", () => {
    const output = transformMcpResult(
      {
        content: [{ text: "structured result", type: "text" }],
        structuredContent: { count: 1, ids: ["result_1"] },
      },
      { serverName: "server", toolName: "search" },
    );

    expect(output).toMatchObject({
      metadata: {
        contentTypes: ["text"],
        server: "server",
        source: "mcp",
        structuredContent: { count: 1, ids: ["result_1"] },
        tool: "search",
      },
      output: "structured result",
    });
  });
});
