import { describe, expect, it } from "vitest";
import {
  detectPaths,
  getCommandRoots,
  matchesPattern,
  parseCommand,
} from "./index.js";

describe("command-parser", () => {
  it("extracts command roots from sequenced shell commands", () => {
    expect(getCommandRoots("git status && npm test | rg fail; echo done")).toEqual([
      "git",
      "npm",
      "rg",
      "echo",
    ]);
  });

  it("unwraps common command wrappers", () => {
    expect(getCommandRoots("sudo -E env FOO=bar git push origin main")).toEqual(
      ["git"],
    );
    expect(getCommandRoots("command npm install")).toEqual(["npm"]);
  });

  it("detects path-like command arguments without treating flags as paths", () => {
    expect(
      detectPaths("rm -rf /tmp/build ./dist ../outside ~/notes \"src/app.ts\""),
    ).toEqual(["/tmp/build", "./dist", "../outside", "~/notes", "src/app.ts"]);
  });

  it("marks unterminated quotes as parse errors while preserving tokens", () => {
    const parsed = parseCommand('echo "unterminated');

    expect(parsed.hasError).toBe(true);
    expect(parsed.roots).toEqual(["echo"]);
    expect(parsed.details[0]?.text).toBe("echo unterminated");
  });

  it("matches command patterns with wildcards", () => {
    expect(matchesPattern("git push -f origin main", "git push*")).toBe(true);
    expect(matchesPattern("git status", "git push*")).toBe(false);
    expect(matchesPattern("npm run build", "npm * build")).toBe(true);
  });
});
