import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { analyzeShellCommand } from "../../../packages/ohbaby-agent/src/shell/analysis/index.js";
import {
  createPermissionState,
  createPermissionManager,
  evaluatePermission,
  generatePermissionPattern,
  InvalidPermissionChoiceError,
} from "../../../packages/ohbaby-agent/src/permission/index.js";

const identity = {
  runId: "run",
  sessionId: "child",
  messageId: "message",
  callId: "call",
  toolName: "bash",
  category: "dangerous" as const,
  source: { rootSessionId: "root", ancestorSessionIds: ["root"] },
  signal: new AbortController().signal,
};
describe("trusted shell analysis in permission decisions", () => {
  it.each(["bash", "zsh", "sh"] as const)(
    "allows only the documented lookup forms in %s",
    async (kind) => {
      const workdir = path.resolve("test workspace");
      const shellPath = workdir.split(path.sep).join("/");
      const state = createPermissionState({ bus: createBus() }).getState();
      const commands = [
        "pwd",
        "ls",
        "ls src",
        "ls -la",
        "ls -la src",
        "ls src 2>/dev/null",
        "ls ~/.ohbaby",
        'cat "my file.txt"',
        "cat a.txt 2>&1",
        "cat ~/a.txt",
        "head -n 20 a.txt",
        "tail -n 20 a.txt",
        "wc -l",
        "wc -l a.txt",
        "cd src && pwd",
        "cd src && ls -la",
        "cd a && cd b && cat x.txt",
        "cd src && head -n 10 a.ts && tail -n 10 a.ts",
        "cd src 2>/dev/null && ls",
        "git status",
        "git status --short",
        "git status --porcelain",
        "git status --short --branch",
        "git status 2>/dev/null",
        `cd "${shellPath}" && git status`,
        "cd . && git status --short",
        "cd sub && cd .. && git status --porcelain",
      ];
      for (const command of commands) {
        const shellAnalysis = await analyzeShellCommand(command, kind, workdir);
        expect(
          evaluatePermission(
            { ...identity, params: { command }, shellAnalysis },
            state,
          ),
          command,
        ).toEqual({ type: "allow" });
      }
    },
  );

  it("retains command approval outside the exact argv, repository and syntax allowances", async () => {
    const state = createPermissionState({ bus: createBus() }).getState();
    const commands = [
      "pwd -P",
      "ls -a",
      "ls -l",
      "ls -al",
      "ls -R",
      "ls a b",
      "ls src -la",
      "cat",
      "cat -",
      "cat -n a",
      "cat a b",
      "head a",
      "head -n10 a",
      "head -n -5 a",
      "head -n 10 a b",
      "tail -f a",
      "tail -n +5 a",
      "tail -n 20",
      "wc a",
      "wc -w a",
      "wc -l a b",
      "wc -l -",
      "wc --files0-from=list.txt",
      "cd",
      "cd sub",
      "cd -",
      "cd -P sub && pwd",
      "pwd && cd sub",
      "cd +1 && pwd",
      "cd sub && cat ../file",
      "cd sub && cd ../other && ls",
      "cd sub && cd ../other && cd .. && git status",
      "ls && >/dev/null",
      "cat sub/../file",
      "cd sub; ls",
      "cd sub || ls",
      "cd sub | ls",
      "ls; pwd",
      "ls\npwd",
      "ls &",
      "cat a | wc -l",
      "grep foo a",
      "rg foo",
      "find . -name '*.ts'",
      "echo hi",
      "sort a",
      "uniq a",
      "git status -s",
      "git status -sb",
      "git status --porcelain=v2",
      "git status --branch --short",
      "git status -- src",
      "git -C . status",
      "git --no-pager status",
      "git log",
      "git diff",
      "git show HEAD",
      "git rev-parse HEAD",
      "git branch",
      "cd src && git status",
      "cd /tmp && git status",
      "cd src; git status",
      "cd /absolute-workspace && git status",
      "FOO=1 ls",
      "env FOO=1 ls",
      "command ls",
      "nohup ls",
      "time pwd",
      "/bin/ls",
      "./git status",
      "LS",
      "cat.exe file",
      "cat a < input",
      "wc -l < input",
      "wc -l <<EOF\nhi\nEOF",
      "ls > out.txt",
      "ls >/dev/tty",
      "ls src/*.ts",
      "cat $(echo a)",
    ];
    for (const command of commands) {
      const shellAnalysis = await analyzeShellCommand(command, "bash");
      expect(
        evaluatePermission(
          { ...identity, params: { command }, shellAnalysis },
          state,
        ).type,
        command,
      ).toBe("ask");
    }
  });

  it.each([
    ["powershell", "pwd"],
    ["powershell", "ls"],
    ["powershell", "Get-Content a.txt"],
    ["powershell", "git status"],
    ["cmd", "dir"],
    ["cmd", "type a.txt"],
    ["cmd", "git status"],
  ] as const)("retains the %s approval for %s", async (kind, command) => {
    const shellAnalysis = await analyzeShellCommand(command, kind);
    expect(
      evaluatePermission(
        { ...identity, params: { command }, shellAnalysis },
        createPermissionState({ bus: createBus() }).getState(),
      ).type,
    ).toBe("ask");
  });

  it("asks default incomplete calls despite old broad allow and keeps Always unavailable", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "*",
      decision: "allow",
      scope: "session",
    });
    const call = {
      ...identity,
      params: { command: "echo $(printf value)" },
      shellAnalysis: await analyzeShellCommand("echo $(printf value)", "bash"),
    };
    expect(evaluatePermission(call, state.getState())).toMatchObject({
      type: "ask",
      rememberable: false,
    });
    const manager = createPermissionManager({ bus, state });
    try {
      const response = manager.ask(call);
      const pending = manager.listPending()[0];
      expect(pending).toMatchObject({
        rootSessionId: "root",
        sessionId: "child",
        metadata: { rememberable: false },
      });
      expect(() =>
        manager.respond("child", pending.id, { type: "always" }),
      ).toThrow(InvalidPermissionChoiceError);
      expect(manager.getPending(pending.id)).toBeDefined();
      manager.respond("child", pending.id, { type: "once" });
      await expect(response).resolves.toBe("once");
    } finally {
      manager.dispose();
    }
  });
  it("keeps deny priority and treats missing trusted analysis conservatively", async () => {
    const state = createPermissionState({ bus: createBus() });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "*",
      decision: "allow",
      scope: "session",
    });
    const missing = {
      ...identity,
      params: { command: "ls", shellAnalysis: { completeness: "complete" } },
    };
    expect(evaluatePermission(missing, state.getState())).toMatchObject({
      type: "ask",
      rememberable: false,
    });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "ls",
      decision: "deny",
      scope: "session",
    });
    expect(evaluatePermission(missing, state.getState()).type).toBe("deny");
  });
  it("preserves only git and docker arity while ordinary and multi commands use whole patterns", async () => {
    for (const [command, expected] of [
      ["git status", "bash(git status *)"],
      ["docker ps", "bash(docker ps *)"],
      ["npm run test", "bash(npm run test)"],
      ["git status; npm run test", "bash(git status; npm run test)"],
    ]) {
      expect(
        generatePermissionPattern({
          type: "bash",
          name: "bash",
          params: { command },
          shellAnalysis: await analyzeShellCommand(command, "bash"),
        }),
      ).toBe(expected);
    }
  });
  it("does not auto approve an incomplete request when another request adds Always", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let id = 0;
    const manager = createPermissionManager({
      bus,
      state,
      generateId: () => `permission-${++id}`,
    });
    try {
      const dynamic = manager.ask({
        ...identity,
        callId: "dynamic",
        params: { command: "git $(printf add) README.md" },
        shellAnalysis: await analyzeShellCommand(
          "git $(printf add) README.md",
          "bash",
        ),
      });
      const complete = manager.ask({
        ...identity,
        callId: "complete",
        params: { command: "git add --dry-run README.md" },
        shellAnalysis: await analyzeShellCommand(
          "git add --dry-run README.md",
          "bash",
        ),
      });
      manager.respond("child", "permission-2", { type: "always" });
      await expect(complete).resolves.toBe("always");
      expect(manager.getPending("permission-1")).toBeDefined();
      manager.respond("child", "permission-1", { type: "once" });
      await expect(dynamic).resolves.toBe("once");
    } finally {
      manager.dispose();
    }
  });
});
