export function generateCustomInstructionsPrompt(
  instructions: readonly string[],
): string {
  if (instructions.length === 0) {
    return "";
  }

  const rendered = instructions
    .map(
      (instruction, index) => `## Source ${String(index + 1)}\n${instruction}`,
    )
    .join("\n\n");

  return `<custom_instructions>\n# Custom Instructions\n${rendered}\n</custom_instructions>`;
}
