export interface GenerateToolGuidancePromptOptions {
  readonly tools?: readonly string[];
  readonly toolSnippets?: Readonly<Partial<Record<string, string>>>;
}

export function generateToolGuidancePrompt(
  options: GenerateToolGuidancePromptOptions,
): string {
  const tools = options.tools ?? [];
  const snippets = options.toolSnippets ?? {};
  const visibleTools = tools.filter((toolName) => {
    const snippet = snippets[toolName];
    return snippet !== undefined && snippet.trim() !== "";
  });

  if (visibleTools.length === 0) {
    return "";
  }

  const lines = ["<tool_guidance>", "Available tool notes:"];
  for (const toolName of visibleTools) {
    lines.push(`- ${toolName}: ${snippets[toolName]?.trim() ?? ""}`);
  }
  lines.push("</tool_guidance>");
  return lines.join("\n");
}
