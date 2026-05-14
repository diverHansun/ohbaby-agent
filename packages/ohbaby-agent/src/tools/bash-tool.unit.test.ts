import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import type { CommandContext } from "../sandbox/index.js";
import type { Tool } from "../core/tool-scheduler/index.js";
import type { SpawnCommand } from "./bash-tool.js";
import { createBuiltinTools } from "./index.js";

class FakeChildProcess extends EventEmitter {
  readonly pid = 123;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

function createContext(
  overrides: Partial<ToolExecutionContext> = {},
  commandContext: CommandContext = {
    cwd: "D:/workspace",
    env: { FOO: "bar" },
    kind: "host-local",
  },
): ToolExecutionContext & {
  resolveCommandContext(): CommandContext;
} {
  return {
    callId: "call_1",
    messageId: "message_1",
    sessionId: "session_1",
    signal: new AbortController().signal,
    ...overrides,
    resolveCommandContext(): CommandContext {
      return commandContext;
    },
  };
}

function getBashTool(options: Parameters<typeof createBuiltinTools>[0]): Tool {
  const tool = createBuiltinTools(options).find((candidate) => candidate.name === "bash");
  if (!tool) {
    throw new Error("bash tool missing");
  }

  return tool;
}

describe("bash builtin tool", () => {
  it("executes commands with shell and command context cwd/env", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => child as unknown as ChildProcess,
    );
    const bash = getBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree: vi.fn(),
      },
      spawn,
    });

    const resultPromise = bash.execute(
      { command: "echo hello", timeout: 1_000 },
      createContext(),
    );
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.emit("exit", 0, null);
    const result = await resultPromise;

    expect(spawn.mock.calls[0]?.[0]).toBe("/bin/bash");
    expect(spawn.mock.calls[0]?.[1]).toEqual(["-lc", "echo hello"]);
    expect(spawn.mock.calls[0]?.[2].cwd).toBe("D:/workspace");
    expect(spawn.mock.calls[0]?.[2].detached).toBe(true);
    expect(spawn.mock.calls[0]?.[2].env?.FOO).toBe("bar");
    expect(result.output).toContain("hello");
    expect(result.metadata).toMatchObject({ exitCode: 0, signal: null });
  });

  it("rejects unsupported shell syntax before spawning", async () => {
    const spawn = vi.fn();
    const bash = getBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree: vi.fn(),
      },
      spawn,
    });

    await expect(
      bash.execute({ command: "echo $(rm -rf /tmp)" }, createContext()),
    ).rejects.toThrow("Unsupported shell syntax");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects command prefixes until the bridge defines their execution contract", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(() => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcess;
    });
    const bash = getBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree: vi.fn(),
      },
      spawn,
    });

    await expect(
      bash.execute(
        { command: "echo hello" },
        createContext(
          {},
          {
            commandPrefix: ["docker", "exec", "container"],
            cwd: "/workspace",
            kind: "container",
          },
        ),
      ),
    ).rejects.toThrow("commandPrefix");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses cmd arguments for Windows command shells", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(() => child as unknown as ChildProcess);
    const bash = getBashTool({
      shell: {
        acceptable: () => "C:\\Windows\\System32\\cmd.exe",
        killTree: vi.fn(),
      },
      spawn,
    });

    const resultPromise = bash.execute({ command: "echo hello" }, createContext());
    child.emit("exit", 0, null);
    await resultPromise;

    expect(spawn.mock.calls[0]?.[1]).toEqual(["/d", "/s", "/c", "echo hello"]);
  });

  it("kills the process tree on timeout", async () => {
    const child = new FakeChildProcess();
    const killTree = vi.fn(() => Promise.resolve());
    const bash = getBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree,
      },
      spawn: vi.fn(() => child as unknown as ChildProcess),
    });

    await expect(
      bash.execute({ command: "sleep 10", timeout: 1 }, createContext()),
    ).rejects.toThrow("timed out");
    expect(killTree).toHaveBeenCalledWith(child);
  });

  it("rejects with the command error even if process cleanup fails", async () => {
    const child = new FakeChildProcess();
    const killTree = vi.fn(() => Promise.reject(new Error("cleanup failed")));
    const bash = getBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree,
      },
      spawn: vi.fn(() => child as unknown as ChildProcess),
    });

    await expect(
      bash.execute({ command: "sleep 10", timeout: 1 }, createContext()),
    ).rejects.toThrow("timed out");
    expect(killTree).toHaveBeenCalledWith(child);
  });

  it("kills the process tree on abort", async () => {
    const child = new FakeChildProcess();
    const abort = new AbortController();
    const killTree = vi.fn(() => Promise.resolve());
    const bash = getBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree,
      },
      spawn: vi.fn(() => child as unknown as ChildProcess),
    });

    const resultPromise = bash.execute(
      { command: "sleep 10" },
      createContext({ signal: abort.signal }),
    );
    abort.abort();

    await expect(resultPromise).rejects.toThrow("cancelled");
    expect(killTree).toHaveBeenCalledWith(child);
  });
});
