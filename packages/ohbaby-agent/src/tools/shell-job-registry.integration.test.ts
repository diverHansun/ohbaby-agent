import { InMemoryShellJobStore } from "./shell-job-store.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
  it("keeps a finished shell's same-group child charged until observation confirms it is gone", async () => {
    const workdir = await mkdtemp(
      path.join(os.tmpdir(), "ohbaby-shell-descendant-"),
    );
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({
      store,
      killTree: killShellTree,
      backgroundLimit: () => Promise.resolve(1),
    });
    const bash = createBashTool({ registry });
    const context = createContext(workdir);
    try {
      const first = await bash.execute(
        {
          command: "sleep 1 >/dev/null 2>&1 & echo started",
          run_in_background: true,
        },
        context,
      );
      const id = String(first.metadata?.jobId);
      await vi.waitFor(
        () => {
          expect(store.get(id)).toMatchObject({
            status: "completed",
            cleanup: null,
          });
        },
        { timeout: 2000 },
      );
      await expect(
        bash.execute({ command: "true", run_in_background: true }, context),
      ).rejects.toThrow("capacity");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const second = await bash.execute(
        { command: "true", run_in_background: true },
        context,
      );
      expect(second.metadata?.jobId).toBeTruthy();
      await vi.waitFor(() => {
        expect(store.get(id)).toMatchObject({
          cleanup: "confirmed",
        });
      });
      expect(typeof store.get(id)?.settledAt).toBe("number");
    } finally {
      await registry.dispose();
      await rm(workdir, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "persists real stdout and stderr beyond capture (background=%s)",
    async (background) => {
      const workdir = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-full-output-")),
      );
      const storage = path.join(workdir, "owner");
      await mkdir(storage);
      const registry = new ShellJobRegistry({ killTree: killShellTree });
      const bash = createBashTool({ registry });
      const quote = (value: string): string =>
        `'${value.replaceAll("'", "'\\''")}'`;
      const script = path.join(workdir, "large-output.mjs");
      await writeFile(
        script,
        "import fs from 'node:fs'; fs.writeSync(1, Buffer.alloc(524288, 65)); fs.writeSync(2, Buffer.alloc(524288, 66)); fs.writeSync(1, 'stdout-end'); fs.writeSync(2, 'stderr-end');",
      );
      const base = createContext(workdir);
      if (!base.environment) throw new Error("Missing fixture environment");
      const context = {
        ...base,
        sessionId: "child-session",
        environment: {
          ...base.environment,
          trustedRoots: (): ReturnType<
            NonNullable<ToolExecutionEnvironment["trustedRoots"]>
          > => [{ kind: "session-storage", path: storage }],
        },
      };
      try {
        const started = await bash.execute(
          {
            command: `exec ${quote(process.execPath)} ${quote(script)}`,
            run_in_background: background,
            timeout: 5000,
          },
          context,
        );
        const result = background
          ? await createTaskOutputTool(registry).execute(
              { job_id: started.metadata?.jobId, block: true, wait_ms: 5000 },
              context,
            )
          : started;
        expect(result.metadata).toMatchObject({
          status: "completed",
          exitCode: 0,
          truncated: true,
          outputFile: { status: "full" },
        });
        const file = (result.metadata?.outputFile as { path: string }).path;
        expect(file).toBe(
          path.join(
            storage,
            "tool-results",
            `${String(result.metadata?.jobId)}.log`,
          ),
        );
        const bytes = await readFile(file);
        expect(bytes.length).toBe(1_048_596);
        expect(bytes.filter((byte) => byte === 65).length).toBe(524288);
        expect(bytes.filter((byte) => byte === 66).length).toBe(524288);
        expect(bytes.toString("utf8")).toContain("stdout-end");
        expect(bytes.toString("utf8")).toContain("stderr-end");
        await registry.dispose();
        expect(await readFile(file)).toEqual(bytes);
      } finally {
        await registry.dispose();
        await rm(workdir, { force: true, recursive: true });
      }
    },
  );
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

      registry.markRootRunStopped("root-a", "owner-ended");
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
