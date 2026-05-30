import { describe, expect, it } from "vitest";

import { generateCustomInstructionsPrompt } from "../layers/custom.js";

describe("custom instruction layer", () => {
  it("renders loaded instructions as a custom prompt layer", () => {
    const prompt = generateCustomInstructionsPrompt(["# Project", "# Global"]);

    expect(prompt).toContain("Custom Instructions");
    expect(prompt).toContain("# Project");
    expect(prompt).toContain("# Global");
    expect(generateCustomInstructionsPrompt([])).toBe("");
  });
});
