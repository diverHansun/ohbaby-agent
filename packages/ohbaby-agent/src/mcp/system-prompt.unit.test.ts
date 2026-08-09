import { describe, expect, it } from "vitest";
import { generateMcpToolMenuPrompt } from "./system-prompt.js";

describe("MCP system prompt", () => {
  it("announces sorted unloaded names and explains search without exposing descriptions", () => {
    const prompt = generateMcpToolMenuPrompt({
      toolNames: ["mcp_z", "mcp_a", "mcp_z"],
    });

    expect(prompt).toContain("search available MCP tools by query");
    expect(prompt).toContain("- mcp_a\n- mcp_z");
    expect(prompt.match(/- mcp_z/gu)).toHaveLength(1);
  });

  it("omits the MCP prompt block when no tools are available", () => {
    expect(generateMcpToolMenuPrompt({ toolNames: [] })).toBe("");
  });
});
