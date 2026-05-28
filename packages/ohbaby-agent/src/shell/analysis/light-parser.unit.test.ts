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

  it("does not treat grep and rg search patterns as path args", async () => {
    const result = await analyzeShellCommand(
      "rg .env src && grep token ../outside.txt",
      "bash",
    );

    expect(result.commands[0]).toMatchObject({
      pathArgs: ["src"],
      root: "rg",
    });
    expect(result.commands[1]).toMatchObject({
      pathArgs: ["../outside.txt"],
      root: "grep",
    });
  });

  it("uses command-specific path positions for modes, options, and redirection", async () => {
    const result = await analyzeShellCommand(
      "chmod 600 ../outside.txt && git -C ../repo status && echo ok > ../out.txt",
      "bash",
    );

    expect(result.commands[0]).toMatchObject({
      pathArgs: ["../outside.txt"],
      root: "chmod",
    });
    expect(result.commands[1]).toMatchObject({
      arityKey: "git status *",
      danger: "readonly",
      pathArgs: ["../repo"],
      root: "git",
    });
    expect(result.commands[2]).toMatchObject({
      pathArgs: ["../out.txt"],
      root: "echo",
    });
  });

  it("extracts find traversal options and git global path options", async () => {
    const result = await analyzeShellCommand(
      "find -L ../outside -name token && git --work-tree=../tree --git-dir ../repo/.git status && git -C=../other status",
      "bash",
    );

    expect(result.commands[0]).toMatchObject({
      pathArgs: ["../outside"],
      root: "find",
    });
    expect(result.commands[1]).toMatchObject({
      arityKey: "git status *",
      pathArgs: ["../tree", "../repo/.git"],
      root: "git",
    });
    expect(result.commands[2]).toMatchObject({
      arityKey: "git status *",
      pathArgs: ["../other"],
      root: "git",
    });
  });

  it("identifies interpreter and direct script execution without treating ordinary script args as paths", async () => {
    const result = await analyzeShellCommand(
      [
        "python ~/.agents/skills/crawl/scripts/run.py data.json",
        "node scripts/build.js --watch",
        "./tools/run.sh out",
        "bash setup.sh deploy --prod",
      ].join(" && "),
      "bash",
    );

    expect(result.commands[0]).toMatchObject({
      executedScript: "~/.agents/skills/crawl/scripts/run.py",
      interpreter: "python",
      pathArgs: [],
      root: "python",
    });
    expect(result.commands[1]).toMatchObject({
      executedScript: "scripts/build.js",
      interpreter: "node",
      pathArgs: [],
      root: "node",
    });
    expect(result.commands[2]).toMatchObject({
      executedScript: "./tools/run.sh",
      pathArgs: [],
      root: "./tools/run.sh",
    });
    expect(result.commands[3]).toMatchObject({
      executedScript: "setup.sh",
      pathArgs: [],
      root: "bash",
    });
  });

  it("extracts path-like script arguments and common path option values", async () => {
    const result = await analyzeShellCommand(
      [
        "python run.py ../outside/input.json",
        "python run.py --output-dir C:\\Users\\u\\AppData\\Local\\Temp\\crawl4ai",
        "node build.js --out dist --watch",
      ].join(" && "),
      "bash",
    );

    expect(result.commands[0]).toMatchObject({
      executedScript: "run.py",
      pathArgs: ["../outside/input.json"],
    });
    expect(result.commands[1]).toMatchObject({
      executedScript: "run.py",
      pathArgs: ["C:\\Users\\u\\AppData\\Local\\Temp\\crawl4ai"],
    });
    expect(result.commands[2]).toMatchObject({
      executedScript: "build.js",
      pathArgs: ["dist"],
    });
  });

  it("marks inline eval facts without inventing an executed script", async () => {
    const result = await analyzeShellCommand(
      "python -c 'print(1)' && node -e 'console.log(1)'",
      "bash",
    );

    expect(result.commands[0]).toMatchObject({
      inlineEval: true,
      interpreter: "python",
      pathArgs: [],
      root: "python",
    });
    expect(result.commands[0]).not.toHaveProperty("executedScript");
    expect(result.commands[1]).toMatchObject({
      inlineEval: true,
      interpreter: "node",
      pathArgs: [],
      root: "node",
    });
    expect(result.commands[1]).not.toHaveProperty("executedScript");
  });
});
