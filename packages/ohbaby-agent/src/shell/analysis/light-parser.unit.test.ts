import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "./index.js";

describe("shell command analysis", () => {
  it("describes sequenced commands without applying workspace boundaries", async () => {
    const result = await analyzeShellCommand(
      "cat ../notes/today.md && git status",
      "bash",
    );

    expect(result).toMatchObject({ shellKind: "bash" });
    expect(result.commands).toEqual([
      {
        arityKey: "cat *",
        danger: "readonly",
        hasDynamic: false,
        pathArgs: ["../notes/today.md"],
        root: "cat",
        source: "cat ../notes/today.md",
        tokens: ["cat", "../notes/today.md"],
      },
      {
        arityKey: "git status *",
        danger: "readonly",
        hasDynamic: false,
        pathArgs: [],
        root: "git",
        source: "git status",
        tokens: ["git", "status"],
      },
    ]);
  });

  it("extracts absolute and sensitive-looking path args as facts", async () => {
    const result = await analyzeShellCommand("cat /etc/hosts .env", "bash");

    expect(result.commands[0]).toMatchObject({
      pathArgs: ["/etc/hosts", ".env"],
      root: "cat",
    });
  });

  it("classifies mutating and dangerous commands per command", async () => {
    const result = await analyzeShellCommand(
      "git push origin main && rm -rf build",
      "bash",
    );

    expect(result.commands.map((command) => command.danger)).toEqual([
      "mutating",
      "dangerous",
    ]);
    expect(result.commands.map((command) => command.arityKey)).toEqual([
      "git push *",
      "rm *",
    ]);
  });

  it("marks dynamic expressions without throwing", async () => {
    const result = await analyzeShellCommand(
      "cat $(find . -name token.txt)",
      "bash",
    );

    expect(result.parseError).toBeDefined();
    expect(result.commands[0]).toMatchObject({
      hasDynamic: true,
      root: "cat",
    });
  });

  it("handles PowerShell path options as shell facts", async () => {
    const result = await analyzeShellCommand(
      "Get-Content -LiteralPath ..\\outside.txt",
      "powershell",
    );

    expect(result.commands[0]).toMatchObject({
      arityKey: "get-content *",
      danger: "readonly",
      pathArgs: ["..\\outside.txt"],
      root: "get-content",
    });
  });
});
