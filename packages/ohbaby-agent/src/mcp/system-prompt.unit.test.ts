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

  it("bounds the menu to 20 complete names and explains the omitted count", () => {
    const names = Array.from(
      { length: 23 },
      (_, index) => `mcp_tool_${String(index).padStart(2, "0")}_complete_name`,
    );
    const prompt = generateMcpToolMenuPrompt({ toolNames: names });
    expect(
      prompt.split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(20);
    expect(prompt).toContain("- mcp_tool_19_complete_name");
    expect(prompt).not.toContain("mcp_tool_20_complete_name");
    expect(prompt).toContain("3 additional tools omitted");
    expect(prompt).toContain("select_tools(query)");
  });

  it("omits the MCP prompt block when no tools are available", () => {
    expect(generateMcpToolMenuPrompt({ toolNames: [] })).toBe("");
  });
});
