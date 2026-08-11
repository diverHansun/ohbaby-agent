import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import type {
  ToolExecutionContext,
  ToolExecutionEnvironment,
} from "../core/tool-scheduler/index.js";
import { Shell } from "../shell/index.js";
import { createBashTool } from "./bash.js";
import {
  createTaskKillTool,
  createTaskOutputTool,
  ShellJobRegistry,
} from "./shell-job-registry.js";

function createContext(workdir: string): ToolExecutionContext {
  const commandContext = { cwd: workdir, env: {}, kind: "host-local" as const };
  const environment: ToolExecutionEnvironment = {
    workdir,
    resolvePath: (inputPath) => path.resolve(workdir, inputPath),
    resolvePathForExisting: (inputPath) =>
      Promise.resolve(path.resolve(workdir, inputPath)),
    resolvePathForWrite: (inputPath) =>
      Promise.resolve(path.resolve(workdir, inputPath)),
    resolveCommandContext: () => commandContext,
  };
  return {
    callId: "call_1",
    environment,
    messageId: "message_1",
    sessionId: "session_1",
    signal: new AbortController().signal,
  };
}

function killShellTree(child: ChildProcess): Promise<void> {
  return Shell.killTree(child);
}

describe("shell job real-process integration", () => {
  it("runs a background command and reads its terminal output", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-"));
    const registry = new ShellJobRegistry({ killTree: killShellTree });
    const bash = createBashTool({ registry });
    const output = createTaskOutputTool(registry);
    try {
      const context = createContext(workdir);
      const started = await bash.execute(
        {
          command: "printf 'background-ready\\n'",
          run_in_background: true,
          timeout: 1_000,
        },
        context,
      );
      const result = await output.execute(
        {
          block: true,
          job_id: started.metadata?.jobId,
          wait_ms: 1_000,
        },
        context,
      );

      expect(result.output).toContain("background-ready");
      expect(result.metadata).toMatchObject({ status: "completed" });
    } finally {
      await registry.dispose();
      await rm(workdir, { force: true, recursive: true });
    }
  });

  it("automatically times out a real background process", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-"));
    const registry = new ShellJobRegistry({ killTree: killShellTree });
    const bash = createBashTool({ registry });
    const output = createTaskOutputTool(registry);
    try {
      const context = createContext(workdir);
      const started = await bash.execute(
        { command: "sleep 2", run_in_background: true, timeout: 50 },
        context,
      );
      const result = await output.execute(
        {
          block: true,
          job_id: started.metadata?.jobId,
          wait_ms: 1_000,
        },
        context,
      );

      expect(result.metadata).toMatchObject({ status: "timed_out" });
      expect(result.metadata).toHaveProperty("exitCode");
      expect(result.metadata).toHaveProperty("signal");
    } finally {
      await registry.dispose();
      await rm(workdir, { force: true, recursive: true });
    }
  });

  it("cancels a real background process through task_kill", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-"));
    const registry = new ShellJobRegistry({ killTree: killShellTree });
    const bash = createBashTool({ registry });
    const kill = createTaskKillTool(registry);
    try {
      const context = createContext(workdir);
      const started = await bash.execute(
        { command: "sleep 2", run_in_background: true, timeout: 1_000 },
        context,
      );
      const result = await kill.execute(
        { job_id: started.metadata?.jobId },
        context,
      );

      expect(result.metadata).toMatchObject({ status: "cancelled" });
    } finally {
      await registry.dispose();
      await rm(workdir, { force: true, recursive: true });
    }
  });
});
