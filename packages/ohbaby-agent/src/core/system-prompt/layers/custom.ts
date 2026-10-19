import type { CustomInstruction } from "../types.js";

const SCOPE_TITLES = {
  global: "Global Instructions",
  project: "Project Instructions",
} as const;

const PRECEDENCE_RULE =
  "Global instructions are defaults; project instructions are more specific and win when they conflict. The user's current explicit request, host permission rules, and the delegated task scope take precedence over both, and none of these instructions grant extra permissions.";

export function generateCustomInstructionsPrompt(
  instructions: readonly CustomInstruction[],
): string {
  if (instructions.length === 0) {
    return "";
  }

  const rendered = ["global", "project"]
    .flatMap((scope) =>
      instructions.filter((instruction) => instruction.scope === scope),
    )
    .map(
      (instruction) =>
        `## ${SCOPE_TITLES[instruction.scope]}\n${instruction.text}`,
    )
    .join("\n\n");

  return `<custom_instructions>\n# Custom Instructions\n${PRECEDENCE_RULE}\n\n${rendered}\n</custom_instructions>`;
}
