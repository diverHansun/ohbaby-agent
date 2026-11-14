import { InMemoryShellJobStore } from "./shell-job-store.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ShellJobSnapshot } from "./shell-job-registry.js";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import {
  createTaskKillTool,
  createTaskOutputTool,
  ShellJobRegistry,
} from "./shell-job-registry.js";

class FakeChild extends EventEmitter {
  readonly pid = 42;
  readonly stdin = { end: vi.fn() };
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const emitted = super.emit(eventName, ...args);
    if (eventName === "exit") {
      super.emit("close", ...args);
    }
    return emitted;
  }

  emitExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    super.emit("exit", exitCode, signal);
    super.emit("close", exitCode, signal);
  }

  emitExitOnly(exitCode: number | null, signal: NodeJS.Signals | null): void {
    super.emit("exit", exitCode, signal);
  }
}

function context(
  sessionId = "session_1",
  contextScopeId?: string,
): ToolExecutionContext {
  return {
    callId: "call_1",
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    messageId: "message_1",
    sessionId,
    signal: new AbortController().signal,
  };
}

function startJob(
  registry: ShellJobRegistry,
  child: FakeChild,
  timeoutMs = 1_000,
  sessionId = "session_1",
  contextScopeId?: string,
): Promise<ShellJobSnapshot> {
  return registry.start({
    child: () => child as unknown as ChildProcess,
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    sessionId,
    timeoutMs,
  });
}

describe("ShellJobRegistry", () => {
  it("only checkpoints background output after new bytes arrive", async () => {
    vi.useFakeTimers();
    const store = new InMemoryShellJobStore();
    const child = new FakeChild();
    const registry = new ShellJobRegistry({
      store,
      killTree: () => undefined,
      probeTree: () => "stopped",
    });
    try {
      await registry.start({
        child: () => child as unknown as ChildProcess,
        sessionId: "session_1",
        background: true,
        timeoutMs: null,
      });
      const changed = vi.fn();
      const unsubscribe = store.subscribe(changed);
      await vi.advanceTimersByTimeAsync(3000);
      expect(changed).not.toHaveBeenCalled();
      child.stdout.emit("data", "new output");
      await vi.advanceTimersByTimeAsync(1000);
      expect(changed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(changed).toHaveBeenCalledTimes(1);
      unsubscribe();
      child.emitExit(0, null);
      await registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["exited", "different-group"] as const)(
    "does not save a late or unrelated process identity (%s)",
    async (scenario) => {
      const store = new InMemoryShellJobStore();
      const child = new FakeChild();
      const registry = new ShellJobRegistry({
        store,
        killTree: () => undefined,
        probeTree: () => "stopped",
        readProcessIdentity: (pid) => {
          if (pid === child.pid && scenario === "exited")
            child.emitExit(0, null);
          return Promise.resolve({
            state: "present",
            pid,
            pgid:
              scenario === "different-group" && pid === child.pid ? 99 : pid,
            startToken: "native-birth",
          });
        },
      });
      try {
        const started = await registry.start({
          sessionId: "session_1",
          background: true,
          timeoutMs: null,
          child: () => child as unknown as ChildProcess,
        });
        expect(store.get(started.jobId)?.processStartToken).toBeNull();
        if (scenario !== "exited") child.emitExit(0, null);
      } finally {
        await registry.dispose();
      }
    },
  );

  it("reports accepted only for the stop that starts cleanup", async () => {
    const child = new FakeChild();
    let stopped = false;
    const registry = new ShellJobRegistry({
      killTree: () => undefined,
      probeTree: () => (stopped ? "stopped" : "running"),
    });
    const started = await startJob(registry, child, 10000);
    await expect(
      registry.stopForUser(started.jobId, "session_1", undefined, () => {
        throw new Error("binding changed");
      }),
    ).rejects.toThrow("binding changed");
    expect(registry.get(started.jobId, "session_1").status).toBe("running");
    const first = await registry.stopForUser(
      started.jobId,
      "session_1",
      undefined,
    );
    const second = await registry.stopForUser(
      started.jobId,
      "session_1",
      undefined,
    );
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("already-terminal");
    stopped = true;
    child.emitExit(0, null);
    await registry.dispose();
  });

  it("wakes a task_output wait on user steer without stopping its job", async () => {
    const child = new FakeChild();
    const killTree = vi.fn();
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: () => "stopped",
    });
    const started = await startJob(registry, child, 10000);
    let wake!: () => void;
    const unsubscribe = vi.fn();
    const pending = createTaskOutputTool(registry).execute(
      { block: true, job_id: started.jobId, wait_ms: 5000 },
      {
        ...context(),
        subscribeSteer: (callback) => {
          wake = callback;
          return Promise.resolve(unsubscribe);
        },
      },
    );
    await vi.waitFor(() => {
      expect(wake).toBeDefined();
    });
    wake();
    expect((await pending).metadata).toMatchObject({ status: "running" });
    expect(killTree).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    child.emitExit(0, null);
    await registry.dispose();
  });

  it("seals a cancelled root before invoking a later spawn while allowing another root", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    let admitted = true;
    const registry = new ShellJobRegistry({
      killTree: vi.fn(),
      admitsOwner: (owner) => owner.runId !== "A" || admitted,
      probeTree: (): "stopped" => "stopped",
    });
    const input = {
      child: spawn,
      sessionId: "session",
      timeoutMs: 10_000,
      owner: {
        sessionId: "session",
        rootRunId: "A",
        runId: "A",
        messageId: "message",
        callId: "call",
      },
    };
    admitted = false;
    await expect(registry.start(input)).rejects.toThrow(/root run.*closed/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(registry.hasActiveWork("A")).toBe(false);
    try {
      expect(
        (
          await registry.start({
            ...input,
            owner: { ...input.owner, rootRunId: "B", runId: "B" },
          })
        ).status,
      ).toBe("running");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      child.emitExit(0, null);
      await registry.dispose();
    }
  });
  it("retains and cancels a root-owned process when admission closes during spawn", async () => {
    const child = new FakeChild();
    let stopped = false;
    const release = vi.fn();
    const killTree = vi.fn();
    let admitted = true;
    const registry = new ShellJobRegistry({
      killTree,
      admitsOwner: () => admitted,
      probeTree: (): "running" | "stopped" => (stopped ? "stopped" : "running"),
    });
    const owner = {
      sessionId: "session",
      rootRunId: "A",
      runId: "A",
      messageId: "message",
      callId: "call",
    };
    const launch = (): ChildProcess => {
      admitted = false;
      return child as unknown as ChildProcess;
    };
    try {
      const job = await registry.start({
        child: launch,
        owner,
        release,
        sessionId: "session",
        timeoutMs: 10_000,
      });
      expect(job.status).toBe("cancelled");
      expect(killTree).toHaveBeenCalledTimes(1);
      expect(registry.hasActiveWork("A")).toBe(true);
      expect(release).not.toHaveBeenCalled();
      registry.markRootRunStopped("A", "owner-ended");
      expect(killTree).toHaveBeenCalledTimes(1);
    } finally {
      stopped = true;
      child.emitExit(0, null);
      await registry.dispose();
    }
    expect(registry.hasActiveWork("A")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("cancels only root-owned foreground and background jobs while retaining unfinished cleanup", async () => {
    const killed: ChildProcess[] = [];
    const stopped = new Set<ChildProcess>();
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const killTree = vi.fn(async (child: ChildProcess): Promise<void> => {
      killed.push(child);
      await cleanupGate;
      stopped.add(child);
      (child as unknown as FakeChild).emitExit(null, "SIGTERM");
    });
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (child): "stopped" | "running" =>
        stopped.has(child) ? "stopped" : "running",
    });
    const jobs = await Promise.all(
      [
        {
          rootRunId: "A",
          executionId: "execution-A",
          captureMode: "head" as const,
        },
        {
          rootRunId: "A",
          executionId: "execution-A2",
          captureMode: "tail" as const,
        },
        {
          rootRunId: "B",
          executionId: "execution-B",
          captureMode: "tail" as const,
        },
      ].map(async (identity, index) => {
        const child = new FakeChild();
        const release = vi.fn();
        const snapshot = await registry.start({
          child: () => child as unknown as ChildProcess,
          sessionId: "reused-child",
          contextScopeId: "reused-instance",
          captureMode: identity.captureMode,
          timeoutMs: 10_000,
          release,
          owner: {
            ...identity,
            rootSessionId: "primary",
            sessionId: "reused-child",
            contextScopeId: "reused-instance",
            runId: `child-${String(index)}`,
            messageId: "message",
            callId: `call-${String(index)}`,
          },
        });
        return { child, release, snapshot };
      }),
    );
    try {
      expect(registry.hasActiveWork("missing")).toBe(false);
      registry.markRootRunStopped("missing", "owner-ended");
      registry.markRootRunStopped("A", "owner-ended");
      expect(
        jobs
          .slice(0, 2)
          .map(
            ({ snapshot }) =>
              registry.get(snapshot.jobId, "reused-child", "reused-instance")
                .status,
          ),
      ).toEqual(["cancelled", "cancelled"]);
      await vi.waitFor(() => {
        expect(killed).toHaveLength(2);
      });
      expect(killed).not.toContain(jobs[2].child);
      expect(
        registry.get(jobs[2].snapshot.jobId, "reused-child", "reused-instance")
          .status,
      ).toBe("running");
      expect(registry.hasActiveWork("A")).toBe(true);
      expect(jobs[0].release).not.toHaveBeenCalled();
      registry.markRootRunStopped("A", "owner-ended");
      expect(killTree).toHaveBeenCalledTimes(2);
      finishCleanup();
      await vi.waitFor(() => {
        expect(registry.hasActiveWork("A")).toBe(false);
        expect(jobs[0].release).toHaveBeenCalledTimes(1);
        expect(jobs[1].release).toHaveBeenCalledTimes(1);
      });
      registry.markRootRunStopped("A", "owner-ended");
      expect(killTree).toHaveBeenCalledTimes(2);
      expect(registry.hasActiveWork("B")).toBe(true);
    } finally {
      finishCleanup();
      await registry.dispose();
    }
  });
  it("counts background work until close drains its pipes, but ignores completed records", async () => {
    const child = new FakeChild();
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "activity",
      killTree: vi.fn(),
    });
    expect(registry.hasActiveWork()).toBe(false);
    await startJob(registry, child);
    expect(registry.hasActiveWork()).toBe(true);
    child.emitExitOnly(0, null);
    expect(registry.hasActiveWork()).toBe(true);
    child.emit("close", 0, null);
    await vi.waitFor(() => {
      expect(registry.hasActiveWork()).toBe(false);
    });
  });

  it("keeps a bounded tail and marks it truncated", async () => {
    const child = new FakeChild();
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "job_1",
      killTree: vi.fn(),
    });
    const started = await startJob(registry, child);

    child.stdout.emit("data", "a".repeat(32_000));
    child.stdout.emit("data", "tail");

    const snapshot = registry.get(started.jobId, "session_1");
    expect(snapshot.status).toBe("running");
    expect(snapshot.output).toContain("tail");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.metadata).toMatchObject({
      jobId: "job_1",
      status: "running",
      truncated: true,
    });
  });

  it("lets the first termination reason win and waits for child exit", async () => {
    const child = new FakeChild();
    const killTree = vi.fn((): void => {
      child.emit("close", null, "SIGTERM");
    });
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "job_1",
      killTree,
    });
    const started = await startJob(registry, child, 10);

    const result = await registry.kill(started.jobId, "session_1");

    expect(result.metadata).toMatchObject({
      exitCode: null,
      signal: null,
      status: "cancelled",
    });
    await vi.waitFor(() => {
      expect(killTree).toHaveBeenCalledTimes(1);
    });
    child.emitExit(0, null);
    expect(registry.get(started.jobId, "session_1").status).toBe("cancelled");
  });

  it("persists stop intent before signalling when a store subscriber immediately stops a job", async () => {
    const child = new FakeChild();
    const store = new InMemoryShellJobStore();
    let recordAtSignal: ReturnType<InMemoryShellJobStore["get"]> = null;
    let stopping: Promise<ShellJobSnapshot> | undefined;
    const registry = new ShellJobRegistry({
      store,
      createJobId: (): string => "subscriber-stop",
      probeTree: (): "stopped" => "stopped",
      killTree: (): { status: "confirmed" } => {
        recordAtSignal = store.get("subscriber-stop");
        child.emitExit(null, "SIGTERM");
        return { status: "confirmed" };
      },
    });
    const unsubscribe = store.subscribe((record) => {
      if (record.status === "running" && !stopping)
        stopping = registry.kill(record.jobId, "session_1");
    });
    try {
      await startJob(registry, child);
      await stopping;
      expect(recordAtSignal).toMatchObject({
        status: "cancelled",
        cleanup: "in-progress",
        stopReason: "model",
      });
    } finally {
      unsubscribe();
      child.emitExit(null, "SIGTERM");
      await registry.dispose();
    }
  });

  it.each(["start", "stop"] as const)(
    "does not postpone %s behind continuing output checkpoints",
    async (operation) => {
      vi.useFakeTimers();
      class GatedStore extends InMemoryShellJobStore {
        slow = operation === "start";
        release: (() => void) | undefined;
        override async update(
          jobId: string,
          patch: Parameters<InMemoryShellJobStore["update"]>[1],
        ): Promise<void> {
          if (this.slow)
            await new Promise<void>((resolve) => {
              this.release = resolve;
            });
          await super.update(jobId, patch);
        }
      }
      const child = new FakeChild();
      const store = new GatedStore();
      let started = false;
      let signalled = false;
      const registry = new ShellJobRegistry({
        store,
        createJobId: (): string => "slow-writes",
        probeTree: (): "stopped" => "stopped",
        killTree: (): { status: "confirmed" } => {
          signalled = true;
          return { status: "confirmed" };
        },
      });
      const starting = registry
        .start({
          sessionId: "session_1",
          background: true,
          timeoutMs: null,
          child: () => child as unknown as ChildProcess,
        })
        .then(() => {
          started = true;
        });
      try {
        if (operation === "stop") await starting;
        else await vi.advanceTimersByTimeAsync(0);
        store.slow = true;
        child.stdout.emit("data", "initial output");
        await vi.advanceTimersByTimeAsync(1000);
        if (operation === "stop")
          await registry.kill("slow-writes", "session_1");
        for (let i = 0; i < 5; i++) {
          // Every pending write receives another checkpoint before it commits.
          child.stdout.emit("data", "continuing output");
          await vi.advanceTimersByTimeAsync(1000);
          const release = store.release;
          store.release = undefined;
          release?.();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(store.get("slow-writes")?.status).toBe(
          operation === "start" ? "running" : "cancelled",
        );
        expect(operation === "start" ? started : signalled).toBe(true);
      } finally {
        store.slow = false;
        store.release?.();
        await vi.advanceTimersByTimeAsync(0);
        child.emitExit(null, "SIGTERM");
        await starting;
        await registry.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("coalesces concurrent termination requests", async () => {
    const child = new FakeChild();
    let releaseKill: (() => void) | undefined;
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    const killTree = vi.fn(async (): Promise<void> => {
      await killGate;
      child.emit("close", null, "SIGTERM");
    });
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "job_1",
      killTree,
    });
    const started = await startJob(registry, child);

    const first = registry.kill(started.jobId, "session_1");
    const second = registry.kill(started.jobId, "session_1");
    await vi.waitFor(() => {
      expect(killTree).toHaveBeenCalledTimes(1);
    });
    releaseKill?.();
    await Promise.all([first, second]);

    expect(killTree).toHaveBeenCalledTimes(1);
    expect(registry.get(started.jobId, "session_1").status).toBe("cancelled");
  });

  it("disposes only jobs owned by the removed session", async () => {
    const removedSessionChild = new FakeChild();
    const removedTerminalChild = new FakeChild();
    const retainedSessionChild = new FakeChild();
    let nextJobId = 0;
    const killTree = vi.fn((child: ChildProcess): void => {
      (child as unknown as FakeChild).emit("close", null, "SIGTERM");
    });
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree,
    });
    const removedSessionJob = await startJob(
      registry,
      removedSessionChild,
      1_000_000,
      "session_removed",
    );
    const retainedSessionJob = await startJob(
      registry,
      retainedSessionChild,
      1_000_000,
      "session_retained",
    );
    const removedTerminalJob = await startJob(
      registry,
      removedTerminalChild,
      1_000_000,
      "session_removed",
    );
    removedTerminalChild.emitExit(0, null);

    try {
      await registry.disposeSession("session_removed");

      expect(
        registry.get(removedSessionJob.jobId, "session_removed").status,
      ).toBe("cancelled");
      expect(
        registry.get(removedTerminalJob.jobId, "session_removed").status,
      ).toBe("completed");
      expect(
        registry.get(retainedSessionJob.jobId, "session_retained").status,
      ).toBe("running");
      expect(killTree).toHaveBeenCalledTimes(1);
    } finally {
      retainedSessionChild.emitExit(0, null);
    }
  });

  it("disposes one subagent scope without affecting a sibling scope", async () => {
    const closedScopeChild = new FakeChild();
    const siblingScopeChild = new FakeChild();
    let nextJobId = 0;
    const killTree = vi.fn((child: ChildProcess): void => {
      (child as unknown as FakeChild).emit("close", null, "SIGTERM");
    });
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree,
    });
    const closedScopeJob = await startJob(
      registry,
      closedScopeChild,
      1_000_000,
      "child_session",
      "subagent_1",
    );
    const siblingScopeJob = await startJob(
      registry,
      siblingScopeChild,
      1_000_000,
      "child_session",
      "subagent_2",
    );

    try {
      await registry.disposeScope("child_session", "subagent_1");

      expect(
        registry.get(closedScopeJob.jobId, "child_session", "subagent_1")
          .status,
      ).toBe("cancelled");
      expect(
        registry.get(siblingScopeJob.jobId, "child_session", "subagent_2")
          .status,
      ).toBe("running");
      await expect(
        createTaskOutputTool(registry).execute(
          { job_id: siblingScopeJob.jobId },
          context("child_session", "subagent_1"),
        ),
      ).rejects.toThrow("not owned");
      expect(killTree).toHaveBeenCalledTimes(1);
    } finally {
      siblingScopeChild.emitExit(0, null);
    }
  });

  it("automatically marks a job timed_out", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const killTree = vi.fn((): void => {
        child.emit("close", null, "SIGTERM");
      });
      const registry = new ShellJobRegistry({
        probeTree: (): "stopped" => "stopped",
        createJobId: (): string => "job_1",
        killTree,
      });
      const started = await startJob(registry, child, 10);

      await vi.advanceTimersByTimeAsync(10);

      expect(registry.get(started.jobId, "session_1").metadata).toMatchObject({
        status: "timed_out",
        exitCode: null,
        signal: "SIGTERM",
      });
      expect(killTree).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the execution timeout once the group stops even with open pipes", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const killTree = vi.fn((): void => {
        child.emit("close", null, "SIGTERM");
      });
      const registry = new ShellJobRegistry({
        probeTree: (): "stopped" => "stopped",
        createJobId: (): string => "job_1",
        killTree,
      });
      const started = await startJob(registry, child, 10);

      child.emitExitOnly(0, null);
      await vi.advanceTimersByTimeAsync(10);

      expect(killTree).not.toHaveBeenCalled();
      expect(registry.get(started.jobId, "session_1").metadata.cleanup).toBe(
        "confirmed",
      );
      child.emit("close", 0, null);
      expect(registry.get(started.jobId, "session_1").status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks task_output only for the current read", async () => {
    const child = new FakeChild();
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "job_1",
      killTree: vi.fn(),
    });
    const started = await startJob(registry, child);
    const outputTool = createTaskOutputTool(registry);

    const pending = outputTool.execute(
      { block: true, job_id: started.jobId, wait_ms: 10 },
      context(),
    );
    child.stdout.emit("data", "still running");
    const result = await pending;

    expect(result.metadata).toMatchObject({
      jobId: started.jobId,
      status: "running",
      truncated: false,
    });
    child.emitExit(0, null);
  });

  it("aborts a blocking task_output read without cancelling its job", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const controller = new AbortController();
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "job_1",
      killTree: vi.fn(),
    });
    const started = await startJob(registry, child, 1_000_000);
    const outputTool = createTaskOutputTool(registry);
    try {
      const assertion = expect(
        outputTool.execute(
          { block: true, job_id: started.jobId, wait_ms: 600_000 },
          { ...context(), signal: controller.signal },
        ),
      ).rejects.toThrow("cancelled");

      controller.abort();
      await vi.advanceTimersByTimeAsync(600_000);
      await assertion;
      expect(registry.get(started.jobId, "session_1").status).toBe("running");
    } finally {
      child.emitExit(0, null);
      vi.useRealTimers();
    }
  });

  it("finishes termination when the child never emits close", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const registry = new ShellJobRegistry({
        probeTree: (): "stopped" => "stopped",
        createJobId: (): string => "job_1",
        killTree: vi.fn(),
      });
      const started = await startJob(registry, child, 10);

      await vi.advanceTimersByTimeAsync(1_010);

      expect(registry.get(started.jobId, "session_1").metadata).toMatchObject({
        exitCode: null,
        signal: null,
        status: "timed_out",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses terminal-status-specific text when a job has no output", async () => {
    const failedChild = new FakeChild();
    const cancelledChild = new FakeChild();
    let nextJobId = 0;
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree: (child): void => {
        (child as unknown as FakeChild).emit("close", null, "SIGTERM");
      },
    });
    const failed = await startJob(registry, failedChild);
    const cancelled = await startJob(registry, cancelledChild);

    failedChild.emitExit(1, null);
    const cancelledResult = await registry.kill(cancelled.jobId, "session_1");

    expect(registry.get(failed.jobId, "session_1").output).toBe(
      "Command failed with no output.",
    );
    expect(cancelledResult.output).toBe(
      "Command was cancelled with no output.",
    );
  });

  it("enforces session ownership and makes terminal kill idempotent", async () => {
    const child = new FakeChild();
    const killTree = vi.fn((): void => {
      child.emit("exit", 0, null);
    });
    const registry = new ShellJobRegistry({
      probeTree: (): "stopped" => "stopped",
      createJobId: (): string => "job_1",
      killTree,
    });
    const started = await startJob(registry, child);
    child.emitExit(0, null);
    const killTool = createTaskKillTool(registry);

    await expect(
      killTool.execute({ job_id: started.jobId }, context("other")),
    ).rejects.toThrow("not owned");
    const first = await killTool.execute({ job_id: started.jobId }, context());
    const second = await killTool.execute({ job_id: started.jobId }, context());

    expect(first.metadata).toMatchObject({ status: "completed" });
    expect(second.metadata).toMatchObject({ status: "completed" });
    expect(killTree).not.toHaveBeenCalled();
  });
});
