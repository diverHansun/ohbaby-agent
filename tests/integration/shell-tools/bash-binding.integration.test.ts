import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createPermissionState } from "../../../packages/ohbaby-agent/src/permission/index.js";
import {
  createToolScheduler,
  type ToolExecutionEnvironment,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createBashTool } from "../../../packages/ohbaby-agent/src/tools/bash.js";
import { Shell } from "../../../packages/ohbaby-agent/src/shell/index.js";

function environment(root: string): ToolExecutionEnvironment {
  return {
    workdir: root,
    resolvePath: (value) => path.resolve(root, value),
    resolvePathForExisting: (value) => fs.realpath(path.resolve(root, value)),
    resolvePathForWrite: (value) => Promise.resolve(path.resolve(root, value)),
    resolveCommandContext: () => ({ cwd: root, kind: "host-local" }),
  };
}
const identity = {
  runId: "run",
  callId: "call",
  messageId: "message",
  sessionId: "child",
  toolName: "bash",
};
describe("Bash preparation through scheduler and direct calls", () => {
  it.skipIf(!existsSync("/bin/bash"))(
    "approves incomplete raw syntax once and executes with the originally injected interpreter",
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "ohbaby-shell-binding-"),
      );
      const bus = createBus();
      const state = createPermissionState({ bus });
      state.addSessionRule("child", {
        tool: "bash",
        pattern: "*",
        decision: "allow",
        scope: "session",
      });
      let shellPath = "/bin/bash";
      const asks: unknown[] = [];
      const scheduler = createToolScheduler({
        bus,
        permissionState: state,
        permission: {
          ask(input) {
            asks.push(input);
            shellPath = "/missing/changed-shell";
            return "once";
          },
        },
      });
      scheduler.register(
        createBashTool({
          shell: { acceptable: () => shellPath, killTree: Shell.killTree },
        }),
      );
      try {
        const command =
          "for i in 1 2; do printf '%s' \"$i\"; done; printf '%s' \"$(printf BOUND)\"";
        const result = await scheduler.execute({
          ...identity,
          environment: environment(root),
          params: { command, shellAnalysis: { completeness: "complete" } },
        });
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({
          params: { command },
          shellAnalysis: { completeness: "incomplete", shellKind: "bash" },
          rememberable: false,
        });
        expect(result).toMatchObject({
          status: "success",
          metadata: { exitCode: 0 },
        });
        expect(result.output).toContain("12BOUND");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("rejects static policy and session deny before any path approval or spawn", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    const ask = vi.fn(() => "once" as const);
    const spawn = vi.fn();
    const scheduler = createToolScheduler({
      bus,
      permissionState: state,
      permission: { ask },
    });
    scheduler.register(
      createBashTool({
        spawn,
        shell: { acceptable: () => "/bin/bash", killTree: Shell.killTree },
      }),
    );
    const first = await scheduler.execute({
      ...identity,
      params: { command: "echo $(rm -rf /)" },
    });
    expect(first).toMatchObject({
      status: "rejected",
      error: { type: "PermissionDeniedError" },
    });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "*",
      decision: "deny",
      scope: "session",
    });
    const second = await scheduler.execute({
      ...identity,
      callId: "deny",
      params: { command: "cat /etc/hosts" },
    });
    expect(second.status).toBe("rejected");
    expect(ask).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.skipIf(!existsSync("/bin/bash"))(
    "retains the real exit 2 diagnostics and allows direct calls without environment",
    async () => {
      const tool = createBashTool({
        shell: { acceptable: () => "/bin/bash", killTree: Shell.killTree },
      });
      const result = await tool.execute(
        { command: "printf 'ordinary failure' >&2; exit 2" },
        {
          callId: "direct",
          sessionId: "session",
          messageId: "message",
          signal: new AbortController().signal,
        },
      );
      expect(result).toMatchObject({
        executionOutcome: "error",
        metadata: { exitCode: 2 },
      });
      expect(result.output).toContain("ordinary failure");
      const malformed = await tool.execute(
        { command: 'echo "unterminated' },
        {
          callId: "syntax",
          sessionId: "session",
          messageId: "message",
          signal: new AbortController().signal,
        },
      );
      expect(malformed.metadata?.exitCode).toBe(2);
      expect(malformed.output).toMatch(/unexpected EOF|matching/u);
    },
  );
  it("retains the original binding and uses current environment values while ignoring forged params", async () => {
    const bus = createBus();
    let shell = "/bin/bash";
    const root = process.cwd();
    let commandContext = {
      cwd: root,
      kind: "host-local",
      env: { BIND_PROBE: "before" },
      commandPrefix: ["original-wrapper", "original-prefix"],
    };
    const env = {
      ...environment(root),
      resolveCommandContext: () => commandContext,
    };
    const scheduler = createToolScheduler({
      bus,
      permission: {
        ask(input) {
          expect(input.shellAnalysis?.completeness).toBe("incomplete");
          shell = "/missing/new-shell";
          commandContext = {
            cwd: "/missing/new-cwd",
            kind: "host-local",
            env: { BIND_PROBE: "after" },
            commandPrefix: ["new-wrapper"],
          };
          return "once";
        },
      },
    });
    let captured: unknown;
    const tool = createBashTool({
      shell: { acceptable: () => shell, killTree: Shell.killTree },
      spawn(file, args, options) {
        captured = {
          file,
          args,
          cwd: options.cwd,
          probe: options.env?.BIND_PROBE,
        };
        const child = Object.assign(new EventEmitter(), {
          pid: 123,
          stdin: { end() {} },
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    });
    scheduler.register(tool);
    const command = 'printf "$BIND_PROBE"';
    const result = await scheduler.execute({
      ...identity,
      environment: env,
      params: {
        command,
        shellExecution: { command, shell: "/forged", args: [] },
        shellAnalysis: { completeness: "complete" },
      },
    });
    expect(result.status).toBe("success");
    expect(captured).toEqual({
      file: "original-wrapper",
      args: ["original-prefix", "/bin/bash", "-lc", command],
      cwd: root,
      probe: "after",
    });
  });
  it("blocks a queued call when a new deny is added", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "*",
      decision: "allow",
      scope: "session",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const ask = vi.fn(() => "once" as const);
    const spawn = vi.fn();
    const scheduler = createToolScheduler({
      bus,
      permissionState: state,
      permission: { ask },
      config: { concurrency: { maxConcurrency: 1 } },
    });
    scheduler.register({
      name: "hold",
      description: "Controlled predecessor",
      source: "builtin",
      category: "readonly",
      parametersJsonSchema: {},
      async execute() {
        holding = true;
        await gate;
        return { output: "released" };
      },
    });
    scheduler.register(
      createBashTool({
        shell: { acceptable: () => "/bin/bash", killTree: Shell.killTree },
        spawn,
      }),
    );
    const hold = scheduler.execute({
      ...identity,
      callId: "hold",
      toolName: "hold",
      params: {},
    });
    try {
      await vi.waitFor(() => expect(holding).toBe(true));
      const queued = scheduler.execute({
        ...identity,
        params: {
          command: 'printf "$HOME"',
          shellAnalysis: { completeness: "complete" },
        },
      });
      await vi.waitFor(() =>
        expect(scheduler.getStatus("call")).toBe("queued"),
      );
      expect(ask).toHaveBeenCalledTimes(1);
      state.addSessionRule("child", {
        tool: "bash",
        pattern: "*",
        decision: "deny",
        scope: "session",
      });
      release();
      expect((await queued).status).toBe("rejected");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      release();
      await hold;
    }
  });
  it.skipIf(!existsSync("/bin/bash"))(
    "rechecks an incomplete call after Full Access changes without selecting another shell",
    async () => {
      const bus = createBus();
      const state = createPermissionState({ bus, initialLevel: "full-access" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding = false;
      let shell = "/bin/bash";
      const ask = vi.fn(() => "once" as const);
      const scheduler = createToolScheduler({
        bus,
        permissionState: state,
        permission: { ask },
        config: { concurrency: { maxConcurrency: 1 } },
      });
      scheduler.register({
        name: "hold",
        description: "Controlled predecessor",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: {},
        async execute() {
          holding = true;
          await gate;
          return { output: "released" };
        },
      });
      scheduler.register(
        createBashTool({
          shell: { acceptable: () => shell, killTree: Shell.killTree },
        }),
      );
      const hold = scheduler.execute({
        ...identity,
        callId: "hold",
        toolName: "hold",
        params: {},
      });
      try {
        await vi.waitFor(() => expect(holding).toBe(true));
        const queued = scheduler.execute({
          ...identity,
          params: { command: 'printf "%s" "$(printf RETRY)"' },
        });
        await vi.waitFor(() =>
          expect(scheduler.getStatus("call")).toBe("queued"),
        );
        state.addSessionRule("child", {
          tool: "bash",
          pattern: "*",
          decision: "allow",
          scope: "session",
        });
        state.setLevel("default");
        shell = "/missing/reselected-shell";
        release();
        const result = await queued;
        expect(result.status).toBe("success");
        expect(result.output).toContain("RETRY");
        expect(ask).toHaveBeenCalledTimes(1);
        expect(ask.mock.calls[0]?.[0]).toMatchObject({
          shellAnalysis: { completeness: "incomplete" },
          rememberable: false,
        });
      } finally {
        release();
        await hold;
      }
    },
  );
});
