import { describe, expect, it } from "vitest";
import { formatPermissionRule, parsePermissionPattern } from "./rule.js";

describe("permission rule DSL", () => {
  it("parses lowercase canonical tool patterns", () => {
    expect(parsePermissionPattern("bash(git *)")).toEqual({
      pattern: "git *",
      tool: "bash",
    });
    expect(parsePermissionPattern("edit(src/**)")).toEqual({
      pattern: "src/**",
      tool: "edit",
    });
    expect(parsePermissionPattern("read")).toEqual({ tool: "read" });
  });

  it("normalizes display-cased input into lowercase canonical form", () => {
    expect(parsePermissionPattern("Bash(Git *)")).toEqual({
      pattern: "git *",
      tool: "bash",
    });
  });

  it("rejects invalid pattern syntax with a clear error", () => {
    expect(() => parsePermissionPattern("bash(git *) extra")).toThrow(
      /invalid permission pattern/i,
    );
    expect(() => parsePermissionPattern("")).toThrow(
      /permission pattern is required/i,
    );
  });

  it("formats rules in canonical lowercase form", () => {
    expect(
      formatPermissionRule({
        decision: "allow",
        pattern: "git *",
        scope: "session",
        tool: "bash",
      }),
    ).toBe("bash(git *) -> allow");
  });
});
