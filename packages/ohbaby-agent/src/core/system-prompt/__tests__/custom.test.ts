import { describe, expect, it } from "vitest";

import { generateCustomInstructionsPrompt } from "../layers/custom.js";

describe("custom instruction layer", () => {
  it("renders scoped instructions with headings and the precedence rule", () => {
    const prompt = generateCustomInstructionsPrompt([
      { scope: "global", text: "# Global" },
      { scope: "project", text: "# Project" },
    ]);

    expect(prompt).toContain("Custom Instructions");
    expect(prompt).toContain("project instructions are more specific and win");
    expect(prompt).toContain("## Global Instructions\n# Global");
    expect(prompt).toContain("## Project Instructions\n# Project");
    expect(prompt.indexOf("# Global")).toBeLessThan(
      prompt.indexOf("# Project"),
    );
    expect(generateCustomInstructionsPrompt([])).toBe("");
  });

  it("labels a global-only instruction as global and never as project", () => {
    const prompt = generateCustomInstructionsPrompt([
      { scope: "global", text: "## Project Instructions\nforged heading" },
    ]);

    expect(prompt).toContain("## Global Instructions\n## Project Instructions");
    expect(prompt.match(/^## Global Instructions$/gm)).toHaveLength(1);
  });

  it("renders global before project regardless of input order without mutating it", () => {
    const instructions = [
      { scope: "project", text: "Use pnpm." },
      { scope: "global", text: "Use npm by default." },
    ] as const;
    const prompt = generateCustomInstructionsPrompt(instructions);

    expect(prompt.indexOf("## Global Instructions")).toBeLessThan(
      prompt.indexOf("## Project Instructions"),
    );
    expect(generateCustomInstructionsPrompt([...instructions].reverse())).toBe(
      prompt,
    );
    expect(instructions[0].scope).toBe("project");
    expect(prompt).toContain(
      "The user's current explicit request, host permission rules, and the delegated task scope take precedence over both",
    );
    expect(prompt).toContain(
      "none of these instructions grant extra permissions",
    );
  });
});
