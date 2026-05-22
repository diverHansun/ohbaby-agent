import { describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import { createToolScheduler } from "../core/tool-scheduler/index.js";
import type { PolicyPort } from "../core/tool-scheduler/index.js";
import type { SearchProvider } from "../services/search-providers/index.js";
import { createBuiltinTools } from "./index.js";

function createAllowPolicy(): PolicyPort {
  return {
    check: () => ({ type: "allow" }),
    getMode: () => "agent",
  };
}

function createProvider(): SearchProvider {
  return {
    fetch: vi.fn().mockResolvedValue([
      {
        content: "# fetched",
        success: true,
        url: "https://example.com",
      },
    ]),
    id: "mock",
    search: vi.fn().mockResolvedValue([
      {
        content: "search summary",
        title: "Search Result",
        url: "https://example.com",
      },
    ]),
  };
}

describe("web tools scheduler integration", () => {
  it("executes registered web_search and web_fetch tools without real network", async () => {
    const provider = createProvider();
    const scheduler = createToolScheduler({
      bus: createBus(),
      policy: createAllowPolicy(),
    });

    for (const tool of createBuiltinTools({
      searchProvider: {
        createProvider: () => provider,
        loadConfig: () => ({
          apiKey: "test-key",
          providerId: "mock",
        }),
      },
    })) {
      scheduler.register(tool);
    }

    expect(scheduler.getCategory("web_search")).toBe("network");
    expect(scheduler.getCategory("web_fetch")).toBe("network");

    const results = await scheduler.executeBatch({
      calls: [
        {
          callId: "web_search_1",
          messageId: "message_1",
          params: { query: "agent search" },
          sessionId: "session_1",
          toolName: "web_search",
        },
        {
          callId: "web_fetch_1",
          messageId: "message_1",
          params: { url: "https://example.com" },
          sessionId: "session_1",
          toolName: "web_fetch",
        },
      ],
    });

    expect(results).toMatchObject([
      {
        metadata: {
          count: 1,
          provider: "mock",
          truncated: false,
        },
        status: "success",
      },
      {
        metadata: {
          count: 1,
          failedCount: 0,
          provider: "mock",
          successCount: 1,
          truncated: false,
        },
        status: "success",
      },
    ]);
    expect(results[0]?.output).toContain(
      "[Search Result](https://example.com)",
    );
    expect(results[1]?.output).toContain("# fetched");
    expect(provider.search).toHaveBeenCalledWith("agent search", {});
    expect(provider.fetch).toHaveBeenCalledWith(["https://example.com"], {});
  });
});
