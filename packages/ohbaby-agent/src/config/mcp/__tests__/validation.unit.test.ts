import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_ENABLED,
  DEFAULT_MCP_TIMEOUT,
  DEFAULT_MCP_TRUST,
  McpServerConfigSchema,
  McpServersConfigSchema,
} from "../types.js";

describe("McpServerConfigSchema", () => {
  it("accepts minimal stdio server config and applies safe defaults", () => {
    const parsed = McpServerConfigSchema.parse({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    });

    expect(parsed).toMatchObject({
      args: ["-y", "@modelcontextprotocol/server-memory"],
      command: "npx",
      enabled: DEFAULT_MCP_ENABLED,
      timeout: DEFAULT_MCP_TIMEOUT,
      trust: DEFAULT_MCP_TRUST,
      type: "stdio",
    });
  });

  it("accepts http and sse server configs with headers and tool filters", () => {
    expect(
      McpServerConfigSchema.parse({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
        includeTools: ["search"],
        excludeTools: ["delete"],
        trust: true,
      }),
    ).toMatchObject({
      headers: { Authorization: "Bearer token" },
      includeTools: ["search"],
      excludeTools: ["delete"],
      trust: true,
      type: "http",
    });

    expect(
      McpServerConfigSchema.parse({
        type: "sse",
        url: "https://example.com/events",
      }),
    ).toMatchObject({ type: "sse" });
  });

  it("rejects opencode-style command arrays so command and args stay explicit", () => {
    expect(() =>
      McpServerConfigSchema.parse({
        command: ["npx", "-y", "firecrawl-mcp"],
      }),
    ).toThrow(/command/i);
  });

  it("rejects includeTools and excludeTools entries that overlap", () => {
    expect(() =>
      McpServerConfigSchema.parse({
        command: "npx",
        excludeTools: ["delete"],
        includeTools: ["read", "delete"],
      }),
    ).toThrow(/includeTools.*excludeTools|excludeTools.*includeTools/i);
  });
});

describe("McpServersConfigSchema", () => {
  it("accepts an empty mcpServers object", () => {
    expect(McpServersConfigSchema.parse({ mcpServers: {} })).toEqual({
      mcpServers: {},
    });
  });

  it("rejects server names with leading or trailing whitespace", () => {
    const result = McpServersConfigSchema.safeParse({
      mcpServers: {
        " server": { command: "npx" },
        "server ": { command: "node" },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["mcpServers"]),
      );
    }
  });

  it("validates each configured server with useful issue paths", () => {
    const result = McpServersConfigSchema.safeParse({
      mcpServers: {
        good: { command: "npx" },
        bad: { type: "http", url: "not-a-url", timeout: 0 },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(
        expect.arrayContaining([
          "mcpServers.bad.url",
          "mcpServers.bad.timeout",
        ]),
      );
    }
  });
});
