import { createTaskTool } from "../tools/task.js";
import { InMemoryShellJobStore, type ShellJobRecord } from "./store.js";
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
import { createBashTool } from "../tools/bash.js";
import { ShellJobRegistry } from "./registry.js";

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
  it("returns the original Bash job on promotion and keeps its hard deadline after Stop", async () => {
    const workdir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-promote-")),
    );
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({ store, killTree: killShellTree });
    const controller = new AbortController();
    const context = { ...createContext(workdir), signal: controller.signal };
    const bash = createBashTool({ registry });
    const script = path.join(workdir, "controlled.mjs");
    const states: ShellJobRecord[] = [];
    const unsubscribe = store.subscribe((row) => {
      states.push(row);
    });
    try {
      await writeFile(
        script,
        `import fs from 'node:fs';
fs.appendFileSync('launches', process.pid + '\\n');
process.stdout.write('x'.repeat(65536) + 'before-promotion\\n');
const timer = setInterval(() => {
  if (!fs.existsSync('continue')) return;
  clearInterval(timer);
  console.log('after-promotion');
  setTimeout(() => console.log('past-original-deadline'), 1200);
}, 10);
setTimeout(() => process.exit(0), 2300);
`,
      );
      const quote = (value: string): string =>
        `'${value.replaceAll("'", "'\\''")}'`;
      const receipt = await bash.execute(
        {
          command: `exec ${quote(process.execPath)} ${quote(script)}`,
          wait_ms: 800,
          timeout: 1600,
        },
        context,
      );
      const foreground = states.find(
        (row) => row.mode === "foreground" && row.status === "running",
      );
      if (!foreground) throw new Error("Missing foreground job");
      if (foreground.startedAt === null)
        throw new Error("Missing foreground job");
      const jobId = foreground.jobId;
      expect(receipt.metadata).toMatchObject({
        jobId,
        mode: "background",
        status: "running",
        pid: foreground.pid,
        startedAt: foreground.startedAt,
        deadline: foreground.startedAt + 1600,
      });
      expect(store.get(jobId)?.outputTail).toContain("before-promotion");
      expect(await readFile(path.join(workdir, "launches"), "utf8")).toBe(
        `${String(foreground.pid)}\n`,
      );

      controller.abort();
      expect(registry.get(jobId, context.sessionId).status).toBe("running");
      await writeFile(path.join(workdir, "continue"), "");
      const result = await createTaskTool(registry).execute(
        { action: "output", block: true, job_id: jobId, wait_ms: 3500 },
        createContext(workdir),
      );
      expect(result.metadata).toMatchObject({ jobId, status: "timed_out" });
      expect(result.output).toContain("before-promotion");
      expect(result.output).toContain("after-promotion");
      expect(result.output).not.toContain("past-original-deadline");
      await vi.waitFor(() => {
        expect(store.get(jobId)).toMatchObject({
          mode: "background",
          status: "timed_out",
          noticeState: "pending",
        });
      });
      expect(store.listByOwner(context.sessionId, null)).toHaveLength(1);
    } finally {
      unsubscribe();
      await registry
        .dispose()
        .finally(() => rm(workdir, { force: true, recursive: true }));
    }
  });

  it("lets one foreground command take the last background slot without stopping the other background jobs", async () => {
    const workdir = await mkdtemp(
      path.join(os.tmpdir(), "ohbaby-promote-quota-"),
    );
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({
      store,
      killTree: killShellTree,
      backgroundLimit: (): Promise<number> => Promise.resolve(2),
    });
    const bash = createBashTool({ registry });
    const context = createContext(workdir);
    try {
      const old = await bash.execute(
        { command: "exec sleep 15", run_in_background: true },
        context,
      );
      const results = await Promise.all([
        bash.execute(
          { command: "echo left; exec sleep 15", wait_ms: 200 },
          { ...context, callId: "left" },
        ),
        bash.execute(
          { command: "echo right; exec sleep 15", wait_ms: 200 },
          { ...context, callId: "right" },
        ),
      ]);
      expect(results.map((result) => result.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ mode: "background", status: "running" }),
          expect.objectContaining({
            mode: "foreground",
            status: "cancelled",
            stopReason: "capacity-limit",
          }),
        ]),
      );
      const rows = store.listByOwner(context.sessionId, null);
      expect(rows).toHaveLength(3);
      const refused = rows.find((row) => row.mode === "foreground");
      if (!refused) throw new Error("Missing refused job");
      const refusedResult = results.find(
        (result) => result.metadata?.jobId === refused.jobId,
      );
      expect(refusedResult?.output).toContain(String(refused.callId));
      await vi.waitFor(() => {
        expect(store.get(refused.jobId)).toMatchObject({
          cleanup: "confirmed",
          noticeState: "suppressed",
        });
      });
      await expect(
        store.allocateNoticeBatch({
          sessionId: context.sessionId,
          contextScopeId: null,
        }),
      ).resolves.toBeNull();

      const running = store
        .listByOwner(context.sessionId, null)
        .filter((row) => row.status === "running");
      expect(running).toHaveLength(2);
      expect(running.map((row) => row.jobId)).toContain(old.metadata?.jobId);
      for (const row of running) {
        expect(row.mode).toBe("background");
        expect(() => process.kill(Number(row.pid), 0)).not.toThrow();
      }
    } finally {
      await registry
        .dispose()
        .finally(() => rm(workdir, { force: true, recursive: true }));
    }
  });

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
          ? await createTaskTool(registry).execute(
              {
                action: "output",
                job_id: started.metadata?.jobId,
                block: true,
                wait_ms: 5000,
              },
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
    const output = createTaskTool(registry);
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
          action: "output",
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
    const output = createTaskTool(registry);
    try {
      const context = createContext(workdir);
      const started = await bash.execute(
        { command: "sleep 2", run_in_background: true, timeout: 50 },
        context,
      );
      const result = await output.execute(
        {
          action: "output",
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

  it("cancels a real background process through task", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-"));
    const registry = new ShellJobRegistry({ killTree: killShellTree });
    const bash = createBashTool({ registry });
    const kill = createTaskTool(registry);
    try {
      const context = createContext(workdir);
      const started = await bash.execute(
        { command: "sleep 2", run_in_background: true, timeout: 1_000 },
        context,
      );
      const result = await kill.execute(
        { action: "stop", job_id: started.metadata?.jobId },
        context,
      );

      expect(result.metadata).toMatchObject({
        taskAction: "stop",
        stopResult: "requested",
        status: "cancelled",
        stopReason: "model",
      });
    } finally {
      await registry.dispose();
      await rm(workdir, { force: true, recursive: true });
    }
  });

  it("cleans up a promoted command when its subagent scope closes", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-root-"));
    const registry = new ShellJobRegistry({ killTree: killShellTree });
    const bash = createBashTool({ registry });
    const output = createTaskTool(registry);
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
        promote: boolean,
      ): Promise<{ jobId: string; pid: number }> => {
        const result = await bash.execute(
          {
            command: `exec ${quote(process.execPath)} ${quote(script)} ${id}`,
            ...(promote ? { wait_ms: 50 } : { run_in_background: true }),
            timeout: 15_000,
          },
          context,
        );
        const jobId = result.metadata?.jobId;
        if (typeof jobId !== "string") throw new Error("Missing job ID");
        expect(result.metadata).toMatchObject({ mode: "background" });
        if (promote) expect(result.metadata?.promotedAt).toBeTypeOf("number");
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
      const [jobA, jobB] = await Promise.all([
        start("a", a, true),
        start("b", b, false),
      ]);
      expect(jobA.jobId).not.toBe(jobB.jobId);
      expect(jobA.pid).not.toBe(jobB.pid);
      expect(
        registry.get(jobA.jobId, a.sessionId, a.contextScopeId).status,
      ).toBe("running");
      expect(
        registry.get(jobB.jobId, b.sessionId, b.contextScopeId).status,
      ).toBe("running");

      if (!a.contextScopeId) throw new Error("Missing subagent scope");
      const cleanup = await registry.cleanupScope(
        a.sessionId,
        a.contextScopeId,
      );
      if (!cleanup.confirmed) await cleanup.settled;
      await vi.waitFor(
        () => {
          expect(
            registry.get(jobA.jobId, a.sessionId, a.contextScopeId),
          ).toMatchObject({
            status: "cancelled",
            metadata: {
              mode: "background",
              stopReason: "owner-ended",
              cleanup: "confirmed",
            },
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
        { action: "output", block: true, job_id: jobB.jobId, wait_ms: 5_000 },
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
      await registry
        .dispose()
        .finally(() => rm(workdir, { force: true, recursive: true }));
    }
  });
});
