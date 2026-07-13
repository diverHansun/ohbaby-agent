export interface GenerateMcpToolMenuPromptOptions {
  readonly toolNames?: readonly string[];
}

const FIXED_INSTRUCTIONS = [
  "These MCP tools are available but unloaded.",
  "Use select_tools with exact names to load at most 8 tools for this session/context scope.",
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
