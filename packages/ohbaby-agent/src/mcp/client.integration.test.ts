import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { McpClient } from "./core/client.js";
import type { McpTransport } from "./types.js";

describe("McpClient SDK integration", () => {
  it("discovers and calls tools over a real MCP SDK transport", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });
    server.registerTool(
      "echo",
      {
        annotations: { readOnlyHint: true },
        description: "Echo input text",
        inputSchema: { text: z.string() },
      },
      ({ text }) => ({
        content: [{ text: `echo:${text}`, type: "text" }],
      }),
    );

    await server.connect(serverTransport);
    const client = new McpClient(
      "memory",
      {
        args: [],
        command: "unused",
        enabled: true,
        timeout: 5000,
        trust: true,
        type: "stdio",
      },
      {
        createTransport: (): McpTransport => clientTransport,
      },
    );

    try {
      await client.connect();

      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(tools[0]).toMatchObject({
        description: "Echo input text",
        name: "echo",
      });
      await expect(
        client.callTool({ arguments: { text: "hello" }, name: "echo" }),
      ).resolves.toMatchObject({
        content: [{ text: "echo:hello", type: "text" }],
      });
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
