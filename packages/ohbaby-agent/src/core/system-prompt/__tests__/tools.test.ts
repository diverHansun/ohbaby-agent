import { describe, expect, it } from "vitest";
import { generateToolGuidancePrompt } from "../layers/tools.js";

describe("tool guidance layer", () => {
  it("renders notes only for tools that have snippets", () => {
    const prompt = generateToolGuidancePrompt({
      toolSnippets: {
        grep: "Search file contents.",
        read: "Read one text file.",
      },
      tools: ["read", "grep", "write"],
    });

    expect(prompt).toContain("<tool_guidance>");
    expect(prompt).toContain("- read: Read one text file.");
    expect(prompt).toContain("- grep: Search file contents.");
    expect(prompt).not.toContain("- write:");
  });

  it("returns an empty string when no tool details are available", () => {
    expect(
      generateToolGuidancePrompt({
        tools: [],
      }),
    ).toBe("");
  });
});
