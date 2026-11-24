import { describe, expect, it } from "vitest";
import { normalizeSessionTitle } from "./global-sessions.js";

describe("normalizeSessionTitle", () => {
  it("trims the title and joins whitespace runs into one space", () => {
    expect(normalizeSessionTitle("  a \n\t b  ")).toBe("a b");
  });

  it("returns an empty string for whitespace only", () => {
    expect(normalizeSessionTitle(" \n ")).toBe("");
  });
});
