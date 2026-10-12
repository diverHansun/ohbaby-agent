import { describe, expect, it } from "vitest";
import { matchesPattern } from "./string-match.js";
describe("generic permission string matching", () => {
  it("matches wildcards and flexible whitespace without treating regex punctuation as syntax", () => {
    expect(matchesPattern("git   status --short", "git status*")).toBe(true);
    expect(matchesPattern("tool (a)", "tool (a)")).toBe(true);
    expect(matchesPattern("git push", "git status*")).toBe(false);
  });
});
