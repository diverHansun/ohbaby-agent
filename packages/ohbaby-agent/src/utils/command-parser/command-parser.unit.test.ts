import { describe, expect, it } from "vitest";
import {
  detectPaths,
  getCommandRoots,
  matchesPattern,
  parseCommand,
} from "./index.js";

describe("command-parser", () => {
  it("extracts command roots from sequenced shell commands", () => {
    expect(
      getCommandRoots("git status && npm test | rg fail; echo done"),
    ).toEqual(["git", "npm", "rg", "echo"]);
    expect(getCommandRoots("echo ok\nrm -rf /tmp")).toEqual(["echo", "rm"]);
    expect(getCommandRoots("sleep 1 & rm -rf /tmp")).toEqual(["sleep", "rm"]);
    expect(getCommandRoots("npm test 2>&1 | tee test.log")).toEqual([
      "npm",
      "tee",
    ]);
    expect(getCommandRoots("npm test &> test.log")).toEqual(["npm"]);
  });

  it("keeps token and root index details for downstream shell policy checks", () => {
    const parsed = parseCommand('env FOO=bar cd "dir with spaces" && echo ok');

    expect(parsed.details[0]).toMatchObject({
      root: "cd",
      rootIndex: 2,
      tokens: ["env", "FOO=bar", "cd", "dir with spaces"],
    });
    expect(parsed.details[1]).toMatchObject({
      root: "echo",
      rootIndex: 0,
      tokens: ["echo", "ok"],
    });
  });

  it("unwraps common command wrappers", () => {
    expect(getCommandRoots("sudo -E env FOO=bar git push origin main")).toEqual(
      ["git"],
    );
    expect(getCommandRoots("sudo -u root rm -rf /tmp/build")).toEqual(["rm"]);
    expect(getCommandRoots("command npm install")).toEqual(["npm"]);
  });

  it("detects path-like command arguments without treating flags as paths", () => {
    expect(
      detectPaths('rm -rf /tmp/build ./dist ../outside ~/notes "src/app.ts"'),
    ).toEqual(["/tmp/build", "./dist", "../outside", "~/notes", "src/app.ts"]);
    expect(detectPaths("cat </etc/passwd")).toEqual(["/etc/passwd"]);
    expect(detectPaths("echo hi >../outside.txt")).toEqual(["../outside.txt"]);
    expect(detectPaths("echo hi &>../outside.txt")).toEqual(["../outside.txt"]);
    expect(detectPaths("echo hi &>>../outside.log")).toEqual([
      "../outside.log",
    ]);
    expect(
      detectPaths(
        'type C:\\Users\\me\\file.txt "C:\\Program Files\\app\\config.json"',
      ),
    ).toEqual([
      "C:\\Users\\me\\file.txt",
      "C:\\Program Files\\app\\config.json",
    ]);
  });

  it("marks unsupported or incomplete syntax as parse errors", () => {
    const parsed = parseCommand('echo "unterminated');

    expect(parsed.hasError).toBe(true);
    expect(parsed.roots).toEqual(["echo"]);
    expect(parsed.details[0]?.text).toBe("echo unterminated");
    expect(parseCommand("echo ok $(rm -rf /tmp)").hasError).toBe(true);
    expect(parseCommand("echo `rm -rf /tmp`").hasError).toBe(true);
    expect(parseCommand("cat <(echo secret)").hasError).toBe(true);
  });

  it("matches command patterns with wildcards", () => {
    expect(matchesPattern("git push -f origin main", "git push*")).toBe(true);
    expect(matchesPattern("git status", "git push*")).toBe(false);
    expect(matchesPattern("npm run build", "npm * build")).toBe(true);
  });
});
