import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
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

function killShellTree(child: ChildProcess): ReturnType<typeof Shell.killTree> {
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

  it("stops an already returned background job by root while preserving another root and scope", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-root-"));
    const registry = new ShellJobRegistry({ killTree: killShellTree });
    const bash = createBashTool({ registry });
    const output = createTaskOutputTool(registry);
    const quote = (value: string): string =>
      `'${value.replaceAll("'", "'\\''")}'`;
    const scopedContext = (id: string): ToolExecutionContext => ({
      ...createContext(workdir),
      callId: `call-${id}`,
      messageId: `message-${id}`,
      contextScopeId: `scope-${id}`,
      owner: {
        sessionId: "session_1",
        runId: `child-run-${id}`,
        rootRunId: `root-${id}`,
        executionId: `execution-${id}`,
        contextScopeId: `scope-${id}`,
        callId: `call-${id}`,
        messageId: `message-${id}`,
      },
    });
    try {
      const script = path.join(workdir, "controlled-job.mjs");
      await writeFile(
        script,
        `import fs from 'node:fs';
const id = process.argv[2];
fs.writeFileSync(id + '.pid', String(process.pid));
const deadline = setTimeout(() => process.exit(2), 15000);
const timer = setInterval(() => {
  if (!fs.existsSync(id + '.release')) return;
  clearInterval(timer);
  clearTimeout(deadline);
  fs.writeFileSync(id + '.completed', 'once');
  console.log(id + '-completed');
}, 20);
`,
      );
      const a = scopedContext("a");
      const b = scopedContext("b");
      const start = async (
        id: string,
        context: ToolExecutionContext,
      ): Promise<{ jobId: string; pid: number }> => {
        const result = await bash.execute(
          {
            command: `exec ${quote(process.execPath)} ${quote(script)} ${id}`,
            run_in_background: true,
            timeout: 15_000,
          },
          context,
        );
        const jobId = result.metadata?.jobId;
        if (typeof jobId !== "string") throw new Error("Missing job ID");
        await vi.waitFor(
          async () => {
            const pid = Number(
              await readFile(path.join(workdir, `${id}.pid`), "utf8"),
            );
            expect(Number.isInteger(pid) && pid > 0).toBe(true);
            expect(() => process.kill(pid, 0)).not.toThrow();
          },
          { timeout: 5_000, interval: 20 },
        );
        return {
          jobId,
          pid: Number(await readFile(path.join(workdir, `${id}.pid`), "utf8")),
        };
      };
      const [jobA, jobB] = await Promise.all([start("a", a), start("b", b)]);
      expect(jobA.jobId).not.toBe(jobB.jobId);
      expect(jobA.pid).not.toBe(jobB.pid);
      expect(
        registry.get(jobA.jobId, a.sessionId, a.contextScopeId).status,
      ).toBe("running");
      expect(
        registry.get(jobB.jobId, b.sessionId, b.contextScopeId).status,
      ).toBe("running");

      expect(
        registry.cancelByRootRun("root-a").map((job) => job.jobId),
      ).toEqual([jobA.jobId]);
      await vi.waitFor(
        () => {
          expect(
            registry.get(jobA.jobId, a.sessionId, a.contextScopeId),
          ).toMatchObject({
            status: "cancelled",
            metadata: { cleanup: "confirmed" },
          });
          expect(() => process.kill(jobA.pid, 0)).toThrow();
          expect(registry.hasActiveWork("root-a")).toBe(false);
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(
        registry.get(jobB.jobId, b.sessionId, b.contextScopeId).status,
      ).toBe("running");
      expect(() => process.kill(jobB.pid, 0)).not.toThrow();
      expect(registry.hasActiveWork("root-b")).toBe(true);
      await Promise.all(
        ["a", "b"].map((id) =>
          writeFile(path.join(workdir, `${id}.release`), "release"),
        ),
      );
      const resultB = await output.execute(
        { block: true, job_id: jobB.jobId, wait_ms: 5_000 },
        b,
      );
      expect(resultB.metadata).toMatchObject({
        status: "completed",
        exitCode: 0,
      });
      expect(resultB.output).toContain("b-completed");
      expect(await readFile(path.join(workdir, "b.completed"), "utf8")).toBe(
        "once",
      );
      await expect(
        readFile(path.join(workdir, "a.completed")),
      ).rejects.toHaveProperty("code", "ENOENT");
      expect(
        registry.get(jobA.jobId, a.sessionId, a.contextScopeId).output,
      ).not.toContain("a-completed");
    } finally {
      await registry.dispose();
      await rm(workdir, { force: true, recursive: true });
    }
  });
});
