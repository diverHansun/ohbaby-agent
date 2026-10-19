export interface GenerateMcpToolMenuPromptOptions {
  readonly toolNames?: readonly string[];
}

const FIXED_INSTRUCTIONS = [
  "These MCP tools are available but unloaded.",
  "Use select_tools(query) to search available MCP tools by query, or load exact names, for this session/context scope.",
  "Search is read-only by default; set load=true only when the ranked candidates should be loaded.",
  "Only loaded MCP tools receive callable schemas.",
];

export function generateMcpToolMenuPrompt(
  options: GenerateMcpToolMenuPromptOptions,
): string {
  const toolNames = [...new Set(options.toolNames ?? [])]
    .filter((toolName) => toolName.trim() !== "")
    .sort((left, right) => left.localeCompare(right));
  if (toolNames.length === 0) {
    return "";
  }

  return [
    "<mcp_tool_catalog>",
    ...FIXED_INSTRUCTIONS,
    ...toolNames.slice(0, 20).map((toolName) => `- ${toolName}`),
    ...(toolNames.length > 20
      ? [
          `${String(toolNames.length - 20)} additional tools omitted; use select_tools(query) to search the full menu.`,
        ]
      : []),
    "</mcp_tool_catalog>",
  ].join("\n");
}
