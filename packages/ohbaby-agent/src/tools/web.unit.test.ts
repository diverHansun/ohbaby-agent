import { describe, expect, it, vi } from "vitest";
import type {
  Tool,
  ToolExecutionContext,
} from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";
import { createWebTools } from "./web.js";
import type {
  SearchProvider,
  SearchProviderConfig,
} from "../services/search-providers/index.js";

function createContext(): ToolExecutionContext {
  return {
    callId: "call_1",
    messageId: "message_1",
    sessionId: "session_1",
    signal: new AbortController().signal,
  };
}

function createProvider(): SearchProvider {
  return {
    fetch: vi.fn(),
    id: "mock",
    search: vi.fn(),
  };
}

function findTool(name: string, provider: SearchProvider): Tool {
  const tools = createWebTools({
    createProvider: () => provider,
    loadConfig: () =>
      ({
        apiKey: "test-key",
        providerId: "mock",
      }) satisfies SearchProviderConfig,
  });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool;
}

describe("web builtin tools", () => {
  it("renders web_search results and exposes provider metadata", async () => {
    const provider = createProvider();
    vi.mocked(provider.search).mockResolvedValue([
      {
        content: "Concise summary",
        publishedDate: "2026-01-01",
        rawContent: "Raw summary",
        score: 0.92,
        title: "First result",
        url: "https://example.com/first",
      },
    ]);

    const result = await findTool("web_search", provider).execute(
      {
        exclude_domains: ["blocked.example"],
        include_domains: ["example.com"],
        include_raw_content: true,
        max_characters: 1000,
        num_results: 1,
        query: "agent search",
        time_range: "week",
      },
      createContext(),
    );

    expect(provider.search).toHaveBeenCalledWith("agent search", {
      excludeDomains: ["blocked.example"],
      includeDomains: ["example.com"],
      includeRawContent: true,
      maxCharactersPerResult: 1000,
      numResults: 1,
      timeRange: "week",
    });
    expect(result.output).toContain(
      "1. [First result](https://example.com/first)",
    );
    expect(result.output).toContain("Concise summary");
    expect(result.output).toContain("Raw content:");
    expect(result.output).toContain("Raw summary");
    expect(result.metadata).toMatchObject({
      count: 1,
      provider: "mock",
      truncated: false,
    });
  });

  it("renders web_fetch successes and partial failures", async () => {
    const provider = createProvider();
    vi.mocked(provider.fetch).mockResolvedValue([
      {
        content: "# OK",
        images: ["https://ok.example/image.png"],
        success: true,
        url: "https://ok.example",
      },
      {
        error: "not found",
        success: false,
        url: "https://bad.example",
      },
    ]);

    const result = await findTool("web_fetch", provider).execute(
      {
        include_images: true,
        max_characters: 500,
        urls: ["https://ok.example", "https://bad.example"],
      },
      createContext(),
    );

    expect(provider.fetch).toHaveBeenCalledWith(
      ["https://ok.example", "https://bad.example"],
      {
        includeImages: true,
        maxCharactersPerUrl: 500,
      },
    );
    expect(result.output).toContain("## https://ok.example");
    expect(result.output).toContain("# OK");
    expect(result.output).toContain("Failed: not found");
    expect(result.metadata).toMatchObject({
      count: 2,
      failedCount: 1,
      provider: "mock",
      truncated: false,
    });
  });

  it("supports a single web_fetch url parameter for compatibility", async () => {
    const provider = createProvider();
    vi.mocked(provider.fetch).mockResolvedValue([
      {
        content: "single",
        success: true,
        url: "https://single.example",
      },
    ]);

    await findTool("web_fetch", provider).execute(
      { url: "https://single.example" },
      createContext(),
    );

    expect(provider.fetch).toHaveBeenCalledWith(["https://single.example"], {});
  });

  it("registers web tools through createBuiltinTools with injected provider factory", () => {
    const tools = createBuiltinTools({
      searchProvider: {
        createProvider: () => createProvider(),
        loadConfig: () => ({
          apiKey: "test-key",
          providerId: "mock",
        }),
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch"]),
    );
    expect(tools.find((tool) => tool.name === "web_search")?.category).toBe(
      "network",
    );
  });

  it("requires injected search provider config at execution time", async () => {
    const tool = createWebTools().find(
      (candidate) => candidate.name === "web_search",
    );

    await expect(
      tool?.execute({ query: "agent search" }, createContext()),
    ).rejects.toThrow(/Search provider config loader is required/);
  });
});
