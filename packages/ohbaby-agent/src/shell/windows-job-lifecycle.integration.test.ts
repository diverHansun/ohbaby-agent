import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getSourceCleanupState } from "../core/tool-scheduler/source-cleanup.js";
import { ShellJobRegistry } from "../shell-jobs/registry.js";
import { InMemoryShellJobStore } from "../shell-jobs/store.js";
import { killTree, manageWithWindowsJob } from "./process.js";
import { loadWindowsJobApi } from "./windows-job.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === "win32")(
  "Windows Job runtime lifecycle",
  () => {
    it("settles a short command through Bash in a fresh runtime", async () => {
      const source = (path: string): string =>
        JSON.stringify(new URL(path, import.meta.url).href);
      const runtime = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import { spawn } from 'node:child_process';
        import { createBashTool } from ${source("../tools/bash.ts")};
        import { ShellJobRegistry } from ${source("../shell-jobs/registry.ts")};
        import { InMemoryShellJobStore } from ${source("../shell-jobs/store.ts")};
        import { killTree } from ${source("./process.ts")};
        const registry = new ShellJobRegistry({ store: new InMemoryShellJobStore(), killTree, terminationManagesObservation: true });
        // Exercise Bash's startup ordering with an executable faster than PowerShell startup.
        const tool = createBashTool({ registry, spawn: (_file, _args, options) => spawn(process.execPath, ['-e', 'process.exit(0)'], options) });
        try {
          const result = await tool.execute({ command: 'exit 0', auto_background: false }, { sessionId: 'cold-runtime', callId: 'c', messageId: 'm', signal: new AbortController().signal });
          await registry.dispose();
          process.stdout.write(JSON.stringify(result));
        } catch (error) { console.error(error); process.exitCode = 1; }
      `,
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      runtime.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      runtime.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      try {
        const [code] = (await once(runtime, "close")) as [number | null];
        expect(code, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ metadata: { exitCode: 0 } });
      } finally {
        if (runtime.exitCode === null && runtime.signalCode === null)
          runtime.kill("SIGKILL");
      }
    });

    it.each([0, 7])(
      "releases foreground cleanup after exit %i and run end",
      async (exitCode) => {
        const store = new InMemoryShellJobStore();
        const registry = new ShellJobRegistry({
          store,
          killTree,
          terminationManagesObservation: true,
        });
        const sessionId = randomUUID();
        const owner = {
          sessionId,
          rootSessionId: sessionId,
          rootRunId: sessionId,
          messageId: "m",
          callId: "c",
        };
        try {
          loadWindowsJobApi();
          const started = await registry.start({
            owner,
            sessionId,
            timeoutMs: 5000,
            child: () => {
              const child = spawn(
                process.execPath,
                ["-e", `process.exitCode = ${String(exitCode)}`],
                { windowsHide: true },
              );
              manageWithWindowsJob(child);
              return child;
            },
          });
          const result = await registry.waitForForeground(
            started.jobId,
            sessionId,
            {
              signal: new AbortController().signal,
              onBackground: () => {
                throw new Error("unexpected promotion");
              },
            },
          );
          expect(result.snapshot.exitCode).toBe(exitCode);
          registry.stopForeground(sessionId, "owner-ended");
          await expect
            .poll(() => store.get(started.jobId)?.cleanup)
            .toBe("confirmed");
          expect(getSourceCleanupState(owner)).toBeUndefined();
          expect(store.get(started.jobId)?.status).toBe(
            exitCode === 0 ? "completed" : "failed",
          );
        } finally {
          await registry.dispose();
        }
      },
    );

    it("promotes the same process without moving its hard deadline", async () => {
      const store = new InMemoryShellJobStore();
      const registry = new ShellJobRegistry({
        store,
        killTree,
        terminationManagesObservation: true,
      });
      const sessionId = randomUUID();
      let launches = 0;
      try {
        loadWindowsJobApi();
        const started = await registry.start({
          sessionId,
          timeoutMs: 1500,
          child: () => {
            launches++;
            const child = spawn(
              process.execPath,
              ["-e", "setTimeout(() => {}, 30000)"],
              { windowsHide: true },
            );
            manageWithWindowsJob(child);
            return child;
          },
        });
        const before = store.get(started.jobId);
        if (!before?.pid) throw new Error("missing started process");
        let promotions = 0;
        const result = await registry.waitForForeground(
          started.jobId,
          sessionId,
          {
            waitMs: 100,
            signal: new AbortController().signal,
            onBackground: () => {
              promotions++;
            },
          },
        );
        expect(result.promotion).toBe("converted");
        expect(promotions).toBe(1);
        expect(result.snapshot.jobId).toBe(started.jobId);
        expect(store.get(started.jobId)).toMatchObject({
          pid: before.pid,
          startedAt: before.startedAt,
          timeoutMs: before.timeoutMs,
          mode: "background",
        });
        const deadline = started.metadata.deadline;
        expect(typeof deadline).toBe("number");
        expect(deadline).toBe(Number(before.startedAt) + 1500);
        expect(result.snapshot.metadata.deadline).toBe(deadline);
        await expect
          .poll(() => store.get(started.jobId)?.status, { timeout: 5000 })
          .toBe("timed_out");
        await expect
          .poll(() => store.get(started.jobId)?.cleanup)
          .toBe("confirmed");
        expect(launches).toBe(1);
        expect(alive(before.pid)).toBe(false);
      } finally {
        await registry.dispose();
      }
    });

    it("ends Job members when their owning runtime is force-killed", async () => {
      const sourceUrl = new URL("./process.ts", import.meta.url).href;
      const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
      const runtime = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import { spawn } from 'node:child_process';
      import { manageWithWindowsJob, probeProcessTree } from ${JSON.stringify(sourceUrl)};
      import { loadWindowsJobApi } from ${JSON.stringify(new URL("./windows-job.ts", import.meta.url).href)};
      loadWindowsJobApi();
      const child = spawn(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 30000)'], { windowsHide: true });
      manageWithWindowsJob(child);
      child.stdout.once('data', () => {
        if (probeProcessTree(child) !== 'running') process.exit(2);
        process.stdout.write(String(child.pid));
      });
    `,
        ],
        { cwd: repoRoot, windowsHide: true },
      );
      let member: number | undefined;
      try {
        const [output] = (await once(runtime.stdout, "data")) as [Buffer];
        member = Number(String(output));
        expect(Number.isSafeInteger(member) && member > 0).toBe(true);
        expect(alive(member)).toBe(true);
        const exited = once(runtime, "exit");
        runtime.kill("SIGKILL");
        await exited;
        const memberPid = member;
        await expect
          .poll(() => alive(memberPid), { timeout: 3000 })
          .toBe(false);
      } finally {
        if (runtime.exitCode === null && runtime.signalCode === null)
          runtime.kill("SIGKILL");
        if (
          member !== undefined &&
          Number.isSafeInteger(member) &&
          member > 0 &&
          alive(member)
        )
          process.kill(member);
      }
    });
  },
);
