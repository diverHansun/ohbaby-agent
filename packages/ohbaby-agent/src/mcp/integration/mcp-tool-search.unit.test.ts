import { describe, expect, it } from "vitest";
import { McpToolSearch } from "./mcp-tool-search.js";

describe("McpToolSearch", () => {
  it("finds admitted MCP tools from their original descriptions without returning descriptions", () => {
    const search = new McpToolSearch([
      {
        description: "Search repository issues and pull requests.",
        localName: "mcp_s6_github_t6_search",
        mcpServer: "github",
        mcpToolName: "search",
      },
      {
        description: "Read calendar events for a date range.",
        localName: "mcp_s8_calendar_t4_read",
        mcpServer: "calendar",
        mcpToolName: "read",
      },
    ]);

    const results = search.search("repository issues", 5);
    expect(results.map((result) => result.name)).toEqual([
      "mcp_s6_github_t6_search",
    ]);
    expect(typeof results[0]?.score).toBe("number");
    expect(Object.keys(results[0] ?? {})).toEqual(["name", "score"]);
  });

  it("ranks an exact local name first with score one and keeps fuzzy scores below one", () => {
    const exactName = "mcp_s6_github_t6_search";
    const search = new McpToolSearch([
      {
        description: "Search repository issues.",
        localName: exactName,
        mcpServer: "github",
        mcpToolName: "search",
      },
      {
        description: "Search source repositories.",
        localName: "mcp_s6_gitlab_t6_search",
        mcpServer: "gitlab",
        mcpToolName: "search",
      },
    ]);

    const results = search.search(exactName, 5);

    expect(results[0]).toEqual({ name: exactName, score: 1 });
    expect(results.slice(1).every((result) => result.score < 1)).toBe(true);
  });

  it("normalizes camel case and indexes Chinese text with bigrams", () => {
    const search = new McpToolSearch([
      {
        description: "读取日历事件并返回时间范围。",
        localName: "mcp_s8_calendar_t10_readEvents",
        mcpServer: "calendar",
        mcpToolName: "readEvents",
      },
    ]);

    expect(search.search("read events", 5)).toHaveLength(1);
    expect(search.search("日历", 5)).toHaveLength(1);
  });
});
