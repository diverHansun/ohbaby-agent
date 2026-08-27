import { describe, expect, it } from "vitest";
import { renderStatusPanel } from "./status-panel.js";

describe("renderStatusPanel", () => {
  it("renders a bordered status panel with context window usage", () => {
    const panel = renderStatusPanel({
      contextWindow: {
        composition: {
          "system-prompt": 10_000,
          "builtin-tools": 5_000,
          mcp: 2_000,
          skills: 1_000,
          conversation: 15_000,
          "summarized-conversation": 4_000,
          "subagent-exchanges": 1_400,
        },
        contextWindowRatio: 0.0384,
        contextWindowTokens: 1_000_000,
        currentTokens: 38_400,
        estimatedAt: "2026-06-06T00:00:00.000Z",
        modelId: "fake-model",
        sessionId: "session_1",
      },
      mcps: {
        connected: 1,
        disabled: 0,
        disconnected: 0,
        failed: 0,
      },
      model: {
        label: "GPT-5.5",
      },
      permission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
      promptCacheUsage: {
        accountedInputTokens: 10_000,
        cacheReadShare: 0.614,
        cacheReadTokens: 6_140,
        sessionId: "session_1",
      },
      projectRoot: "D:/Projects/app",
      sessionId: "session_1",
      status: "idle",
      tools: {
        builtin: 1,
        mcp: 1,
        module: 1,
        skill: 1,
      },
    });

    expect(panel).toContain("╭─ Status");
    expect(panel).toContain("│ Runtime  idle");
    expect(panel).toContain("│ Session  session_1");
    expect(panel).toContain("│ Permission auto / default");
    expect(panel).toContain("│ Model    GPT-5.5");
    expect(panel).toContain("│ Context  38.4K / 1M (4%)");
    expect(panel).toContain("│ Cache    hit 61%");
    expect(panel).not.toContain("Cache Cache hit");
    expect(panel.indexOf("│ Cache")).toBeGreaterThan(
      panel.indexOf("│ Context"),
    );
    expect(panel.indexOf("│ Cache")).toBeLessThan(panel.indexOf("│ Tools"));
    expect(panel).not.toContain("System prompt");
    expect(panel).not.toContain("Subagent exchanges");
    expect(panel).toContain("│ Tools    1 builtin, 1 module, 1 skill, 1 mcp");
    expect(panel).toContain("│ MCP      1 connected");
    expect(panel).toContain("│ Project  D:/Projects/app");
    expect(panel).toContain("╰");
  });

  it("uses the unavailable label when context window usage is missing", () => {
    const panel = renderStatusPanel({
      context: {
        contextLimit: 128_000,
        currentTokens: 9_000,
      },
      status: "idle",
    });

    expect(panel).toContain("│ Context  Context unavailable");
    expect(panel).not.toContain("9,000/128,000");
    expect(panel).not.toContain("│ Cache");
  });

  it.each([
    {
      expected: "│ Cache    hit —",
      promptCacheUsage: {
        accountedInputTokens: 0,
        cacheReadShare: null,
        cacheReadTokens: 0,
        sessionId: "session_1",
      },
    },
    {
      expected: "│ Cache    hit 0%",
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: 0,
        cacheReadTokens: 0,
        sessionId: "session_1",
      },
    },
  ])("renders cache state as $expected", ({ expected, promptCacheUsage }) => {
    expect(renderStatusPanel({ promptCacheUsage, status: "idle" })).toContain(
      expected,
    );
  });

  it.each([
    {},
    { promptCacheUsage: null },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: 0.5,
        cacheReadTokens: 101,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: Number.NaN,
        cacheReadTokens: 50,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 0,
        cacheReadShare: 0,
        cacheReadTokens: 0,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: 0.5,
        cacheReadTokens: 50,
        sessionId: "",
      },
    },
  ])("does not render absent or malformed cache usage", (data) => {
    expect(renderStatusPanel({ ...data, status: "idle" })).not.toContain(
      "│ Cache",
    );
  });
});
