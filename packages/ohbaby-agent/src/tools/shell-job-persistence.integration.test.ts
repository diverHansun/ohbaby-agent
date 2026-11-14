import { ShellJobRecovery } from "./shell-job-recovery.js";
import { shellJobFixture } from "./fixtures/shell-job.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { ProcessIdentity } from "../shell/process-identity.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteConnection } from "../services/database/connection.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { Shell } from "../shell/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseShellJobStore,
  InMemoryShellJobStore,
} from "./shell-job-store.js";
import {
  createTaskOutputTool,
  ShellJobRegistry,
} from "./shell-job-registry.js";

afterEach(() => {
  closeDatabase();
});

function killShellTree(child: ChildProcess): ReturnType<typeof Shell.killTree> {
  return Shell.killTree(child);
}

function spawnUntilReleased(releasePath: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require('node:fs');
process.stdout.write('durable-tail');
const deadline = setTimeout(() => process.exit(2), 7000);
const timer = setInterval(() => {
  if (!fs.existsSync(process.argv[1])) return;
  clearInterval(timer);
  clearTimeout(deadline);
  process.stdout.write('-done');
}, 10);
`,
      releasePath,
    ],
    { detached: true },
  );
}

describe("shell job persistence", () => {
  it.each([
    ["Stop", "cancelled", "user"],
    ["hard timeout", "timed_out", "timeout"],
    ["natural exit", "completed", null],
  ] as const)(
    "rechecks %s after SQLite's writer lock is released",
    async (event, status, stopReason) => {
      const dir = await mkdtemp(join(tmpdir(), "shell-job-promotion-lock-"));
      const dbPath = join(dir, "store.db");
      const releasePath = join(dir, "release");
      const controller = new AbortController();
      let registry: ShellJobRegistry | undefined;
      let writer: NodeSqliteConnection | undefined;
      let locked = false;
      try {
        initDatabase({ dbPath });
        const db = getDatabase();
        db.prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
        ).run();
        writer = new NodeSqliteConnection(dbPath);
        const store = new DatabaseShellJobStore();
        const jobs = new ShellJobRegistry({
          store,
          killTree: killShellTree,
        });
        registry = jobs;
        const child: { current?: ChildProcess } = {};
        const started = await jobs.start({
          sessionId: "s",
          timeoutMs: event === "hard timeout" ? 650 : null,
          child: () => {
            child.current = spawnUntilReleased(releasePath);
            return child.current;
          },
        });
        writer.exec("BEGIN IMMEDIATE");
        locked = true;

        const exec = db.exec.bind(db);
        let blocked = false;
        const observedExec = vi
          .spyOn(db, "exec")
          .mockImplementation((sql): void => {
            try {
              exec(sql);
            } catch (error) {
              if (
                sql === "BEGIN IMMEDIATE" &&
                locked &&
                error instanceof Error &&
                /database is locked/i.test(error.message)
              )
                blocked = true;
              throw error;
            }
          });
        try {
          const detached = vi.fn();
          const waiting = jobs.waitForForeground(started.jobId, "s", {
            signal: controller.signal,
            waitMs: 50,
            onBackground: detached,
          });
          await vi.waitFor(() => {
            expect(blocked).toBe(true);
          });

          if (event === "Stop") controller.abort();
          if (event === "natural exit") {
            if (!child.current) throw new Error("Missing spawned process");
            const exited = once(child.current, "exit");
            await writeFile(releasePath, "");
            await expect(exited).resolves.toEqual([0, null]);
          }
          await vi.waitFor(() => {
            expect(jobs.get(started.jobId, "s").status).toBe(status);
          });
          expect(store.get(started.jobId)).toMatchObject({
            mode: "foreground",
            status: "running",
          });
          writer.exec("ROLLBACK");
          locked = false;

          await expect(waiting).resolves.toMatchObject({
            jobId: started.jobId,
            status,
            metadata: { mode: "foreground", stopReason },
          });
          expect(detached).not.toHaveBeenCalled();
          await vi.waitFor(() => {
            expect(store.get(started.jobId)).toMatchObject({
              mode: "foreground",
              promotedAt: null,
              status,
              noticeState: "suppressed",
              cleanup: "confirmed",
            });
          });
        } finally {
          observedExec.mockRestore();
        }
      } finally {
        try {
          if (locked) writer?.exec("ROLLBACK");
          await registry?.dispose();
        } finally {
          writer?.close();
          closeDatabase();
          await rm(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it("checks the admission guard in the actual queued SQLite write callback", async () => {
    initDatabase({ dbPath: ":memory:" });
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
      )
      .run();
    const store = new DatabaseShellJobStore();
    await store.insert(
      shellJobFixture({ status: "lost", cleanup: "unconfirmed" }),
    );
    let valid = true;
    const pending = store.compareAndUpdate(
      "job",
      { trackingReleasedAt: null },
      { trackingReleasedAt: 9 },
      () => {
        if (!valid) throw new Error("binding changed");
      },
    );
    valid = false;
    await expect(pending).rejects.toThrow("binding changed");
    expect(store.get("job")?.trackingReleasedAt).toBeNull();
  });

  it("reclaims quota by observing a dead foreign owner before a new reservation", async () => {
    initDatabase({ dbPath: ":memory:" });
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
      )
      .run();
    const store = new DatabaseShellJobStore();
    await store.insert(shellJobFixture({ jobId: "foreign", cleanup: null }));
    const signal = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend: { ownerId: "local", pid: process.pid, startToken: "local" },
      inspect: () => Promise.resolve({ state: "absent" }),
      probeGroup: () => "stopped",
      signalGroup: signal,
    });
    const registry = new ShellJobRegistry({
      store,
      recovery,
      backgroundLimit: () => Promise.resolve(1),
      refreshOwner: async (id, scope) => {
        for (const row of store.listByOwner(id, scope))
          await recovery.refresh(row.jobId);
      },
      killTree: () => ({ status: "confirmed" }),
    });
    try {
      const next = await registry.start({
        sessionId: "s",
        background: true,
        timeoutMs: 1000,
        child: () => spawn("/bin/sh", ["-c", "true"], { detached: true }),
      });
      expect(next.jobId).toBeTruthy();
      expect(store.get("foreign")).toMatchObject({
        status: "lost",
        cleanup: "confirmed",
        noticeState: "pending",
      });
      expect(signal).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  });

  it("commits the placeholder before spawn and saves the final output and lifecycle", async () => {
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "job",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    const job = await registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      background: true,
      metadata: { command: "printf hello", cwd: "/tmp", shell: "/bin/sh" },
      child: () => {
        expect(store.get("job")).toMatchObject({ status: null, pid: null });
        return spawn("/bin/sh", ["-c", "printf hello"], { detached: true });
      },
    });
    await registry.waitForTerminal(job.jobId, "session");
    await viWait(() => {
      expect(store.get("job")).toMatchObject({
        status: "completed",
        outputBytes: 5,
        outputTail: "hello",
        outputComplete: true,
        cleanup: "confirmed",
      });
    });
    await registry.dispose();
  });
  it("returns foreground output even when the child finishes before start returns", async () => {
    const registry = new ShellJobRegistry({
      createJobId: (): string => "fast",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
      readProcessIdentity: async (): Promise<ProcessIdentity> => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return { state: "unknown", reason: "test" };
      },
    });
    const job = await registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      child: () =>
        spawn("/bin/sh", ["-c", "printf fast-result"], { detached: true }),
    });
    expect((await registry.waitForTerminal(job.jobId, "session")).output).toBe(
      "fast-result",
    );
    await registry.dispose();
  });
  it("reads the promoted job and its tail before and after reopening SQLite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shell-job-persist-"));
    const dbPath = join(dir, "store.db");
    const releasePath = join(dir, "release");
    let registry: ShellJobRegistry | undefined;
    try {
      initDatabase({ dbPath });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('session','p','/tmp','test','active',1,1,'{}')",
        )
        .run();
      const store = new DatabaseShellJobStore();
      registry = new ShellJobRegistry({
        store,
        createJobId: (): string => "persisted",
        killTree: killShellTree,
      });
      const jobs = registry;
      const started = await jobs.start({
        sessionId: "session",
        timeoutMs: 10000,
        child: () => spawnUntilReleased(releasePath),
      });
      await vi.waitFor(() => {
        expect(jobs.get(started.jobId, "session").output).toContain(
          "durable-tail",
        );
      });
      const receipt = await jobs.waitForForeground(started.jobId, "session", {
        signal: new AbortController().signal,
        waitMs: 1,
        onBackground: () => undefined,
      });
      const { startedAt, promotedAt, deadline } = receipt.metadata;
      expect(promotedAt).toBeTypeOf("number");
      expect(deadline).toBe(Number(startedAt) + 10_000);

      const connection = new NodeSqliteConnection(dbPath);
      try {
        const reader = new ShellJobRegistry({
          store: new DatabaseShellJobStore({ db: connection }),
          killTree: killShellTree,
        });
        expect(reader.get(started.jobId, "session")).toMatchObject({
          status: "running",
          output: "durable-tail",
          metadata: {
            jobId: started.jobId,
            mode: "background",
            startedAt,
            promotedAt,
            deadline,
          },
        });
        await reader.dispose();
      } finally {
        connection.close();
      }
      await writeFile(releasePath, "");
      await vi.waitFor(() => {
        expect(store.get("persisted")?.settledAt).toBeTypeOf("number");
      });
      expect(store.get(started.jobId)?.noticeState).toBe("pending");
      await registry.dispose();
      registry = undefined;
      closeDatabase();
      initDatabase({ dbPath });
      const reopened = new ShellJobRegistry({
        store: new DatabaseShellJobStore(),
        killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
      });
      const result = reopened.get("persisted", "session");
      expect(result).toMatchObject({
        jobId: started.jobId,
        status: "completed",
        output: "durable-tail-done",
        metadata: { mode: "background", startedAt, promotedAt, deadline },
      });
      await reopened.dispose();
    } finally {
      try {
        await registry?.dispose();
      } finally {
        closeDatabase();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
  it("retries a failed final write without losing cleanup responsibility", async () => {
    class FailOnceStore extends DatabaseShellJobStore {
      attempts = 0;
      override async update(
        jobId: string,
        patch: Parameters<DatabaseShellJobStore["update"]>[1],
      ): Promise<void> {
        if (patch.settledAt !== undefined) {
          this.attempts++;
          if (this.attempts === 1) throw new Error("transient failure");
        }
        await super.update(jobId, patch);
      }
    }
    initDatabase({ dbPath: ":memory:" });
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('session','p','/tmp','test','active',1,1,'{}')",
      )
      .run();
    const store = new FailOnceStore();
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "retry",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    await registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      background: true,
      child: () => spawn("/bin/sh", ["-c", "printf ok"], { detached: true }),
    });
    await vi.waitFor(() => {
      expect(store.attempts).toBe(1);
    });
    expect(store.get("retry")?.settledAt).toBeNull();
    expect(registry.hasActiveWork()).toBe(true);
    await expect(registry.dispose()).rejects.toThrow();
    expect(registry.hasActiveWork()).toBe(true);
    await vi.waitFor(
      () => {
        expect(store.get("retry")?.settledAt).toBeTypeOf("number");
      },
      { timeout: 3000 },
    );
    expect(store.attempts).toBe(2);
    await vi.waitFor(() => {
      expect(registry.hasActiveWork()).toBe(false);
    });
    await registry.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    expect(store.attempts).toBe(2);
  });
  it("labels recovered output as incomplete and gives its checkpoint", async () => {
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "history",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    await registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      background: true,
      child: () =>
        spawn("/bin/sh", ["-c", "printf recovered"], { detached: true }),
    });
    await vi.waitFor(() => {
      expect(registry.hasActiveWork()).toBe(false);
    });
    await store.update("history", {
      status: "lost",
      outputComplete: false,
      outputBytes: 9,
      outputCheckpointAt: 123456789,
    });
    const reader = new ShellJobRegistry({
      store,
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    const result = await createTaskOutputTool(reader).execute(
      { job_id: "history" },
      {
        sessionId: "session",
        messageId: "m",
        callId: "c",
        signal: new AbortController().signal,
      },
    );
    expect(result.metadata).toMatchObject({
      outputComplete: false,
      outputCheckpointAt: 123456789,
    });
    expect(result.output).toMatch(/at least 9 bytes/i);
    expect(result.output).toMatch(/incomplete/i);
    expect(result.output).toContain(new Date(123456789).toISOString());
    expect(result.output).toContain("recovered");
  });
  it("never spawns when the placeholder cannot be committed", async () => {
    class RejectingStore extends InMemoryShellJobStore {
      override insert(): Promise<void> {
        return Promise.reject(new Error("disk unavailable"));
      }
    }
    const child = vi.fn(() => spawn("/bin/sh", ["-c", "exit 0"]));
    const registry = new ShellJobRegistry({
      store: new RejectingStore(),
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    await expect(
      registry.start({ sessionId: "session", timeoutMs: 10000, child }),
    ).rejects.toThrow("disk unavailable");
    expect(child).not.toHaveBeenCalled();
  });
  it("rechecks cancellation inside the reservation admission", async () => {
    class DelayedAdmissionStore extends InMemoryShellJobStore {
      unblock!: () => void;
      entered!: () => void;
      readonly enteredPromise = new Promise<void>((resolve) => {
        this.entered = resolve;
      });
      readonly gate = new Promise<void>((resolve) => {
        this.unblock = resolve;
      });
      override async insert(
        ...args: Parameters<InMemoryShellJobStore["insert"]>
      ): Promise<void> {
        this.entered();
        await this.gate;
        await super.insert(...args);
      }
    }
    const store = new DelayedAdmissionStore();
    const abort = new AbortController();
    const child = vi.fn(() => spawn("/bin/sh", ["-c", "exit 0"]));
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "admission",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    const start = registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      child,
      signal: abort.signal,
    });
    await store.enteredPromise;
    abort.abort();
    store.unblock();
    await expect(start).rejects.toThrow();
    expect(store.get("admission")).toBeNull();
    expect(child).not.toHaveBeenCalled();
  });
  it("records cancellation after reservation without spawning", async () => {
    class GatedReservationStore extends InMemoryShellJobStore {
      unblock!: () => void;
      reserved!: () => void;
      readonly entered = new Promise<void>((resolve) => {
        this.reserved = resolve;
      });
      readonly gate = new Promise<void>((resolve) => {
        this.unblock = resolve;
      });
      override async insert(
        ...args: Parameters<InMemoryShellJobStore["insert"]>
      ): Promise<void> {
        await super.insert(...args);
        this.reserved();
        await this.gate;
      }
    }
    const store = new GatedReservationStore();
    const abort = new AbortController();
    const child = vi.fn(() => spawn("/bin/sh", ["-c", "exit 0"]));
    const release = vi.fn();
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "cancelled-before-spawn",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    const start = registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      background: true,
      child,
      release,
      signal: abort.signal,
    });
    await store.entered;
    abort.abort();
    store.unblock();
    await expect(start).rejects.toThrow();
    expect(child).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(store.get("cancelled-before-spawn")).toMatchObject({
      status: "cancelled",
      stopReason: "user",
      noticeState: "suppressed",
    });
  });
  it("retains failed spawn resource responsibility when release fails", async () => {
    const store = new InMemoryShellJobStore();
    const release = vi.fn(() =>
      Promise.reject(new Error("resource release failed")),
    );
    const reportCleanupError = vi.fn();
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "failed-release",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    await expect(
      registry.start({
        sessionId: "session",
        timeoutMs: 10000,
        child: () => {
          throw new Error("spawn failed");
        },
        release,
        reportCleanupError,
        owner: {
          sessionId: "session",
          rootRunId: "run",
          messageId: "message",
          callId: "call",
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(store.get("failed-release")).toMatchObject({
      status: "failed",
      cleanup: "confirmed",
      settledAt: null,
    });
    expect(reportCleanupError).toHaveBeenCalled();
    expect(registry.hasActiveWork()).toBe(true);
    expect((await registry.stopByRootRun("run", "owner-ended")).confirmed).toBe(
      false,
    );
    await expect(registry.dispose()).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });
  it("records synchronous spawn failure in the committed placeholder", async () => {
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "spawn-error",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
    });
    await expect(
      registry.start({
        sessionId: "session",
        timeoutMs: 10000,
        background: true,
        child: () => {
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(store.get("spawn-error")).toMatchObject({
      status: "failed",
      error: "spawn failed",
      cleanup: "confirmed",
      noticeState: "pending",
    });
  });
  it("stops at the captured-byte limit and retains the background tail", async () => {
    const store = new InMemoryShellJobStore();
    const registry = new ShellJobRegistry({
      store,
      maxOutputBytes: 5,
      createJobId: (): string => "limited",
      killTree: (child): { status: "unconfirmed" } => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        return { status: "unconfirmed" };
      },
    });
    await registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      background: true,
      child: () =>
        spawn("/bin/sh", ["-c", "printf abcde; sleep 10"], { detached: true }),
    });
    await vi.waitFor(() => {
      expect(store.get("limited")).toMatchObject({
        status: "cancelled",
        stopReason: "output-limit",
        outputBytes: 5,
      });
    });
  });
  it("saves the stop intent before sending a signal", async () => {
    class GatedStore extends InMemoryShellJobStore {
      unblock!: () => void;
      readonly gate = new Promise<void>((resolve) => {
        this.unblock = resolve;
      });
      override async update(
        jobId: string,
        patch: Parameters<InMemoryShellJobStore["update"]>[1],
      ): Promise<void> {
        if (patch.cleanup === "in-progress") await this.gate;
        return super.update(jobId, patch);
      }
    }
    const store = new GatedStore();
    let child!: ReturnType<typeof spawn>;
    const killTree = vi.fn(() => {
      if (child.pid === undefined) throw new Error("Child PID missing");
      process.kill(-child.pid, "SIGKILL");
      return { status: "unconfirmed" as const };
    });
    const registry = new ShellJobRegistry({
      store,
      killTree,
      createJobId: (): string => "gated",
    });
    await registry.start({
      sessionId: "session",
      timeoutMs: 10000,
      child: () => {
        child = spawn("/bin/sh", ["-c", "sleep 10"], { detached: true });
        return child;
      },
    });
    const result = await registry.kill("gated", "session");
    expect(result.status).toBe("cancelled");
    expect(killTree).not.toHaveBeenCalled();
    store.unblock();
    await vi.waitFor(() => {
      expect(killTree).toHaveBeenCalledOnce();
    });
    expect(store.get("gated")).toMatchObject({
      status: "cancelled",
      stopReason: "model",
    });
  });
  it("retains cleanup responsibility when saving the spawned identity fails", async () => {
    class FailingStore extends InMemoryShellJobStore {
      override async update(
        jobId: string,
        patch: Parameters<InMemoryShellJobStore["update"]>[1],
      ): Promise<void> {
        if (patch.status === "running") throw new Error("disk failed");
        return super.update(jobId, patch);
      }
    }
    const store = new FailingStore();
    const release = vi.fn();
    const killTree = vi.fn(() => ({ status: "unconfirmed" as const }));
    const registry = new ShellJobRegistry({
      store,
      killTree,
      cleanupObservationMs: 5,
    });
    let pid: number | undefined;
    await expect(
      registry.start({
        sessionId: "session",
        timeoutMs: 10000,
        release,
        child: () => {
          const child = spawn("/bin/sh", ["-c", "sleep 10"], {
            detached: true,
          });
          pid = child.pid;
          return child;
        },
      }),
    ).rejects.toThrow("disk failed");
    await vi.waitFor(() => {
      expect(killTree).toHaveBeenCalled();
    });
    expect(release).not.toHaveBeenCalled();
    expect(registry.hasActiveWork()).toBe(true);
    process.kill(-Number(pid), "SIGKILL");
  });
});
async function viWait(assertion: () => void): Promise<void> {
  const { vi } = await import("vitest");
  await vi.waitFor(assertion);
}
