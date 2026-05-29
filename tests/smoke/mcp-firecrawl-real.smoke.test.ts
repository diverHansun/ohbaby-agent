import { describe, expect, it } from "vitest";
import {
  formatToolResultContentForModel,
  projectToolMetadataForModel,
} from "../../packages/ohbaby-agent/src/core/context/index.js";
import { McpClient } from "../../packages/ohbaby-agent/src/mcp/core/client.js";
import { adaptMcpTool } from "../../packages/ohbaby-agent/src/mcp/integration/tool-adapter.js";

const runRealFirecrawlSmoke =
  process.env.OHBABY_RUN_REAL_MCP_FIRECRAWL_SMOKE === "1";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

describe("real Firecrawl MCP smoke", () => {
  (runRealFirecrawlSmoke ? it : it.skip)(
    "executes firecrawl_search through the MCP adapter and projects safe metadata",
    async () => {
      const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
      if (!firecrawlApiKey) {
        throw new Error(
          "Set FIRECRAWL_API_KEY for real Firecrawl MCP smoke.",
        );
      }

      const client = new McpClient("firecrawl", {
        args: ["-y", "firecrawl-mcp"],
        command: npxCommand,
        enabled: true,
        env: { FIRECRAWL_API_KEY: firecrawlApiKey },
        timeout: 90_000,
        trust: true,
        type: "stdio",
      });

      try {
        await client.connect();
        const searchDefinition = (await client.listTools()).find(
          (tool) => tool.name === "firecrawl_search",
        );
        if (!searchDefinition) {
          throw new Error("Firecrawl MCP server did not expose firecrawl_search");
        }

        const searchTool = adaptMcpTool(searchDefinition, client);
        const result = await searchTool.execute(
          {
            limit: 1,
            query: "OpenAI Codex CLI",
            sources: [{ type: "web" }],
          },
          {
            callId: "call_firecrawl_search",
            messageId: "message_firecrawl_search",
            sessionId: "session_firecrawl_search",
            signal: new AbortController().signal,
          },
        );
        const output = result.output ?? "";

        expect(result.output).toEqual(expect.any(String));
        expect(output.length).toBeGreaterThan(0);
        expect(result.metadata).toMatchObject({
          contentTypes: ["text"],
          server: "firecrawl",
          source: "mcp",
          tool: "firecrawl_search",
        });

        const projected = projectToolMetadataForModel(
          searchTool.name,
          result.metadata,
        );
        expect(projected).toEqual({
          contentTypes: ["text"],
          server: "firecrawl",
          tool: "firecrawl_search",
        });

        const modelVisible = formatToolResultContentForModel({
          content: output,
          metadata: result.metadata,
          tool: searchTool.name,
        });
        expect(modelVisible).not.toMatch(/^undefined\b/);
        expect(modelVisible).toContain(output.slice(0, 80));
        expect(modelVisible).toContain("<tool_metadata>");
        expect(modelVisible).toContain('"server":"firecrawl"');
        expect(modelVisible).toContain('"tool":"firecrawl_search"');
        expect(modelVisible).toContain('"contentTypes":["text"]');
        expect(modelVisible).not.toContain(firecrawlApiKey);
      } finally {
        await client.disconnect();
      }
    },
    180_000,
  );
});
