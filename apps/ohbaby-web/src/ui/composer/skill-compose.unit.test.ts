import { describe, expect, it } from "vitest";
import { composeSkillText } from "./skill-compose.js";

describe("composeSkillText", () => {
  it("returns plain text unchanged without a skill", () => {
    expect(composeSkillText(null, "  原话  ")).toBe("  原话  ");
  });

  it("sends the skill alone when the request is blank", () => {
    expect(composeSkillText("code-review", "")).toBe("/code-review");
    expect(composeSkillText("code-review", " \n ")).toBe("/code-review");
  });

  it("trims only the ends and keeps inner line breaks", () => {
    expect(composeSkillText("code-review", "\n 看这里\n  第二行 \n")).toBe(
      "/code-review 看这里\n  第二行",
    );
  });
});
