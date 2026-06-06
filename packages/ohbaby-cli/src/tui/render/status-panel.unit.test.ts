import { describe, expect, it } from "vitest";
import { renderStatusPanel } from "./status-panel.js";

describe("renderStatusPanel", () => {
  it("renders a bordered status panel with context window usage", () => {
    const panel = renderStatusPanel({
      contextWindow: {
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
  });
});
