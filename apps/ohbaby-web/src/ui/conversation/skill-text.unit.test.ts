import { describe, expect, it } from "vitest";
import { skillMarkerName, splitSkillText } from "./skill-text.js";

describe("skill text in user bubbles", () => {
  it("reads only a non-empty string marker name", () => {
    expect(skillMarkerName({ skillMarker: { name: "code-review" } })).toBe(
      "code-review",
    );
    expect(skillMarkerName(undefined)).toBeUndefined();
    expect(skillMarkerName({ skillMarker: { name: "" } })).toBeUndefined();
    expect(skillMarkerName({ skillMarker: "code-review" })).toBeUndefined();
  });

  it("splits a marked slash call into the token and the request", () => {
    expect(splitSkillText("/code-review 看看", "code-review")).toEqual({
      skill: "code-review",
      text: "看看",
    });
    expect(splitSkillText("/code-review", "code-review")).toEqual({
      skill: "code-review",
      text: "",
    });
    expect(splitSkillText("/code-review\n  缩进", "code-review")).toEqual({
      skill: "code-review",
      text: "  缩进",
    });
  });

  it("shows the text as it is without a matching marker", () => {
    const old = "/code-review 旧消息";
    expect(splitSkillText(old, undefined)).toEqual({ skill: null, text: old });
    expect(splitSkillText("开头不是 slash", "code-review")).toEqual({
      skill: null,
      text: "开头不是 slash",
    });
    expect(splitSkillText("/code-reviewer x", "code-review")).toEqual({
      skill: null,
      text: "/code-reviewer x",
    });
  });
});
