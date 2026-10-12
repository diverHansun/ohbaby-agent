import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "./index.js";

describe("mature shell analysis", () => {
  it("does not evaluate a command substitution with a filesystem side effect", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-analysis-sentinel-"),
    );
    const sentinel = path.join(root, "side-effect");
    try {
      const result = await analyzeShellCommand(
        `echo $(touch '${sentinel}')`,
        "bash",
      );
      expect(result.completeness).toBe("incomplete");
      await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("does not claim a successful cwd after unconditional cd", async () => {
    const result = await analyzeShellCommand(
      "cd missing; cat file.txt",
      "bash",
    );
    expect(result.completeness).toBe("incomplete");
    expect(result.commands.at(-1)?.cwd).toBeUndefined();
  });
  it("detects cwd-changing wrappers at any depth and joined env options", async () => {
    for (const command of [
      "command env -C /tmp cat secret.txt",
      "env -C/tmp cat secret.txt",
    ]) {
      const result = await analyzeShellCommand(command, "bash");
      expect(result.completeness).toBe("incomplete");
      expect(result.commands[0]?.cwd).toBeUndefined();
    }
    const powershell = await analyzeShellCommand(
      "cd child || Get-Content file.txt",
      "powershell",
    );
    expect(powershell.commands.at(-1)?.cwd).toBeUndefined();
  });
  it("preserves an escaped backslash followed by a literal newline in quotes", async () => {
    const result = await analyzeShellCommand('cat "a\\\\\nb"', "bash");
    expect(result.commands[0]?.pathArgs).toEqual(["a\\\nb"]);
  });
  it("includes expansion in command assignments in completeness", async () => {
    expect(
      await analyzeShellCommand("X=$(echo ok) cat input", "bash"),
    ).toMatchObject({ completeness: "incomplete" });
    expect(
      await analyzeShellCommand("X=$HOME cat input", "bash"),
    ).toMatchObject({ completeness: "incomplete" });
  });
  it("never invents a literal path from line continuation or PowerShell escapes", async () => {
    const quoted = await analyzeShellCommand('cat "/etc/pass\\\nwd"', "bash");
    expect(quoted.commands[0]?.pathArgs).toEqual(["/etc/passwd"]);
    const unquoted = await analyzeShellCommand("cat /etc/pass\\\nwd", "bash");
    expect(unquoted.commands[0]?.pathArgs).toEqual(["/etc/passwd"]);
    const powershell = await analyzeShellCommand(
      "Get-Content ./sec`ret.txt",
      "powershell",
    );
    expect(powershell.commands[0]?.pathArgs).toEqual(["./sec\ret.txt"]);
  });
  it("marks cwd-changing wrappers and guarded cwd changes incomplete", async () => {
    const wrapper = await analyzeShellCommand(
      "env -C /tmp cat secret.txt",
      "bash",
    );
    expect(wrapper.completeness).toBe("incomplete");
    expect(wrapper.commands[0]?.cwd).toBeUndefined();
    const guarded = await analyzeShellCommand(
      "false && cd child; cat file.txt",
      "bash",
    );
    expect(guarded.completeness).toBe("incomplete");
    expect(guarded.commands.at(-1)?.cwd).toBeUndefined();
  });
  it("treats clobber redirection as mutating", async () => {
    const result = await analyzeShellCommand("cat input >| output", "bash");
    expect(result.commands[0]?.danger).toBe("mutating");
  });
  it("does not infer the success cwd for an OR fallback", async () => {
    const result = await analyzeShellCommand(
      "cd child || cat file.txt",
      "bash",
    );
    expect(result.completeness).toBe("incomplete");
    expect(result.commands.at(-1)?.cwd).toBeUndefined();
  });
  it("keeps flag values separate from path positions", async () => {
    const result = await analyzeShellCommand(
      "cat -n secrets.txt; head -n 2 input.txt; wget -O output.sh https://example.test; git worktree add ../tree main",
      "bash",
    );
    expect(result.commands.map((item) => item.pathArgs)).toEqual([
      ["secrets.txt"],
      ["input.txt"],
      ["output.sh"],
      ["../tree"],
    ]);
  });
  it("keeps cwd changes inside a subshell without leaking them to outer commands", async () => {
    const result = await analyzeShellCommand(
      "(cd child && cat file.txt); cat root.txt",
      "bash",
    );
    expect(result.commands.find((item) => item.root === "cat")?.cwd).toBe(
      "child",
    );
    expect(result.commands.at(-1)?.cwd).toBe(".");
  });
  it("associates sequential cd paths and stops resolving relatives after conditional cd", async () => {
    const sequential = await analyzeShellCommand(
      "cd child && cat file.txt",
      "bash",
    );
    expect(sequential.commands[1]).toMatchObject({
      cwd: "child",
      pathArgs: ["file.txt"],
    });
    const conditional = await analyzeShellCommand(
      "if true; then cd elsewhere; fi; cat file.txt /etc/hosts",
      "bash",
    );
    expect(conditional.completeness).toBe("incomplete");
    expect(conditional.commands.at(-1)?.cwd).toBeUndefined();
  });
  it("loads installed Bash and PowerShell grammars and extracts literal commands", async () => {
    const bash = await analyzeShellCommand('cat "a;b" | head -n 1', "bash");
    expect(bash).toMatchObject({ completeness: "complete", shellKind: "bash" });
    expect(bash.commands.map((command) => command.tokens)).toEqual([
      ["cat", "a;b"],
      ["head", "-n", "1"],
    ]);
    const powershell = await analyzeShellCommand(
      "Get-Content -LiteralPath 'a b' | Write-Output",
      "powershell",
    );
    expect(powershell).toMatchObject({ completeness: "complete" });
    expect(powershell.commands[0]).toMatchObject({
      root: "get-content",
      pathArgs: ["a b"],
    });
  });
  it("keeps literal deny facts from substitutions without evaluating them", async () => {
    const result = await analyzeShellCommand("cat $(rm -rf /)", "bash");
    expect(result).toMatchObject({ completeness: "incomplete" });
    expect(
      result.commands.some(
        (command) => command.root === "rm" && command.tokens.includes("/"),
      ),
    ).toBe(true);
  });
  it("reports unsupported dialect and parser recovery as incomplete", async () => {
    expect(await analyzeShellCommand("print -l *(.N)", "zsh")).toMatchObject({
      shellKind: "zsh",
      completeness: "incomplete",
    });
    expect(await analyzeShellCommand("echo ok", "cmd")).toMatchObject({
      shellKind: "cmd",
      completeness: "incomplete",
    });
    expect(
      await analyzeShellCommand('echo "unterminated', "bash"),
    ).toMatchObject({ completeness: "incomplete" });
  });
  it("keeps a custom CLI structurally complete with conservative danger", async () => {
    const result = await analyzeShellCommand("my-build-tool --check", "bash");
    expect(result).toMatchObject({ completeness: "complete" });
    expect(result.commands[0]?.danger).toBe("mutating");
  });
  it("classifies redirections for every command and find side effects", async () => {
    const result = await analyzeShellCommand(
      "cat input > output; git status > status.txt; find . -delete",
      "bash",
    );
    expect(result.commands.map((command) => command.danger)).toEqual([
      "mutating",
      "mutating",
      "mutating",
    ]);
    expect(result.commands[0]?.pathArgs).toEqual(["input", "output"]);
  });
});
