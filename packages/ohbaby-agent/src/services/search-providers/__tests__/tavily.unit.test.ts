import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTavilyProvider,
  InvalidProviderConfigError,
} from "../index.js";

const mocks = vi.hoisted(() => {
  const client = {
    extract: vi.fn(),
    search: vi.fn(),
  };
  return {
    client,
    tavily: vi.fn(() => client),
  };
});

vi.mock("@tavily/core", () => ({
  tavily: mocks.tavily,
}));

describe("Tavily search provider unit", () => {
  beforeEach(() => {
    mocks.client.extract.mockReset();
    mocks.client.search.mockReset();
    mocks.tavily.mockClear();
  });

  it("creates the SDK client with API key, base URL, and proxies", () => {
    const provider = createTavilyProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test",
      defaults: {
        proxy: { http: "http://proxy.example.test:8080" },
      },
      providerId: "tavily",
    });

    expect(provider.id).toBe("tavily");
    expect(mocks.tavily).toHaveBeenCalledWith({
      apiBaseURL: "https://api.example.test",
      apiKey: "test-key",
      proxies: { http: "http://proxy.example.test:8080" },
    });
  });

  it("rejects missing API keys", () => {
    expect(() =>
      createTavilyProvider({ apiKey: "", providerId: "tavily" }),
    ).toThrow(InvalidProviderConfigError);
  });

  it("maps search options and normalizes sorted results", async () => {
    mocks.client.search.mockResolvedValue({
      images: [],
      query: "agent search",
      requestId: "req-search",
      responseTime: 12,
      results: [
        {
          content: "second content",
          publishedDate: "",
          score: 0.2,
          title: "Second",
          url: "https://example.com/second",
        },
        {
          content: "first content",
          publishedDate: "2026-01-01",
          rawContent: "raw first content",
          score: 0.9,
          title: "First",
          url: "https://example.com/first",
        },
      ],
    });
    const provider = createTavilyProvider({
      apiKey: "test-key",
      defaults: {
        search: {
          includeRawContent: "text",
          maxResults: 3,
          searchDepth: "advanced",
          timeout: 10,
          topic: "news",
        },
      },
      providerId: "tavily",
    });

    const results = await provider.search("agent search", {
      country: "US",
      excludeDomains: ["blocked.example"],
      includeDomains: ["example.com"],
      includeRawContent: true,
      maxCharactersPerResult: 5,
      numResults: 2,
      timeRange: "week",
    });

    expect(mocks.client.search).toHaveBeenCalledWith("agent search", {
      country: "US",
      excludeDomains: ["blocked.example"],
      includeDomains: ["example.com"],
      includeRawContent: "text",
      maxResults: 2,
      searchDepth: "advanced",
      timeRange: "week",
      timeout: 10,
      topic: "news",
    });
    expect(results).toEqual([
      {
        content: "first",
        publishedDate: "2026-01-01",
        rawContent: "raw f",
        score: 0.9,
        title: "First",
        url: "https://example.com/first",
      },
      {
        content: "secon",
        score: 0.2,
        title: "Second",
        url: "https://example.com/second",
      },
    ]);
  });

  it("maps fetch options, preserves URL order, and reports partial failures", async () => {
    mocks.client.extract.mockResolvedValue({
      failedResults: [{ error: "not found", url: "https://bad.example" }],
      requestId: "req-fetch",
      responseTime: 20,
      results: [
        {
          images: ["https://ok.example/image.png"],
          rawContent: "markdown content",
          url: "https://ok.example",
        },
      ],
    });
    const provider = createTavilyProvider({
      apiKey: "test-key",
      defaults: {
        extract: {
          extractDepth: "advanced",
          timeout: 9,
        },
      },
      providerId: "tavily",
    });

    const results = await provider.fetch(
      ["https://bad.example", "https://ok.example"],
      {
        format: "text",
        includeImages: true,
        maxCharactersPerUrl: 8,
      },
    );

    expect(mocks.client.extract).toHaveBeenCalledWith(
      ["https://bad.example", "https://ok.example"],
      {
        extractDepth: "advanced",
        format: "text",
        includeImages: true,
        timeout: 9,
      },
    );
    expect(results).toEqual([
      {
        error: "not found",
        success: false,
        url: "https://bad.example",
      },
      {
        content: "markdown",
        images: ["https://ok.example/image.png"],
        success: true,
        url: "https://ok.example",
      },
    ]);
  });

  it("rejects empty queries and URL lists before calling the SDK", async () => {
    const provider = createTavilyProvider({
      apiKey: "test-key",
      providerId: "tavily",
    });

    await expect(provider.search(" ")).rejects.toThrow("query");
    await expect(provider.fetch([])).rejects.toThrow("urls");
    expect(mocks.client.search).not.toHaveBeenCalled();
    expect(mocks.client.extract).not.toHaveBeenCalled();
  });

  it("maps common Tavily API errors to friendly messages", async () => {
    mocks.client.search.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    const provider = createTavilyProvider({
      apiKey: "test-key",
      providerId: "tavily",
    });

    await expect(provider.search("agent search")).rejects.toThrow(
      "authentication failed",
    );
  });
});
