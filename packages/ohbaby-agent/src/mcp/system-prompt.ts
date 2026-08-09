export interface GenerateMcpToolMenuPromptOptions {
  readonly toolNames?: readonly string[];
}

const FIXED_INSTRUCTIONS = [
  "These MCP tools are available but unloaded.",
  "Use select_tools to search available MCP tools by query, or load exact names, for this session/context scope.",
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
    "<mcp_tools>",
    ...FIXED_INSTRUCTIONS,
    ...toolNames.map((toolName) => `- ${toolName}`),
    "</mcp_tools>",
  ].join("\n");
}
