export interface GenerateToolGuidancePromptOptions {
  readonly tools?: readonly string[];
  readonly toolSnippets?: Readonly<Partial<Record<string, string>>>;
  readonly promptGuidelines?: readonly string[];
}

function uniqueNonEmpty(values: readonly string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized !== "" && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
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
  const guidelines = uniqueNonEmpty(options.promptGuidelines ?? []);

  if (visibleTools.length === 0 && guidelines.length === 0) {
    return "";
  }

  const lines = ["<tool_guidance>"];
  if (visibleTools.length > 0) {
    lines.push("Available tool notes:");
    for (const toolName of visibleTools) {
      lines.push(`- ${toolName}: ${snippets[toolName]?.trim() ?? ""}`);
    }
  }
  if (guidelines.length > 0) {
    lines.push("Tool use rules:");
    for (const guideline of guidelines) {
      lines.push(`- ${guideline}`);
    }
  }
  lines.push("</tool_guidance>");
  return lines.join("\n");
}
