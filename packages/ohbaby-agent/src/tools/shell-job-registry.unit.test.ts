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
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

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
): ShellJobSnapshot {
  return registry.start({
    child: child as unknown as ChildProcess,
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    sessionId,
    timeoutMs,
  });
}

describe("ShellJobRegistry", () => {
  it("keeps a bounded tail and marks it truncated", () => {
    const child = new FakeChild();
    const registry = new ShellJobRegistry({
      createJobId: (): string => "job_1",
      killTree: vi.fn(),
    });
    const started = startJob(registry, child);

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
      createJobId: (): string => "job_1",
      killTree,
    });
    const started = startJob(registry, child, 10);

    const result = await registry.kill(started.jobId, "session_1");

    expect(result.metadata).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      status: "cancelled",
    });
    expect(killTree).toHaveBeenCalledTimes(1);
    child.emitExit(0, null);
    expect(registry.get(started.jobId, "session_1").status).toBe("cancelled");
  });

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
      createJobId: (): string => "job_1",
      killTree,
    });
    const started = startJob(registry, child);

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
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree,
    });
    const removedSessionJob = startJob(
      registry,
      removedSessionChild,
      1_000_000,
      "session_removed",
    );
    const retainedSessionJob = startJob(
      registry,
      retainedSessionChild,
      1_000_000,
      "session_retained",
    );
    const removedTerminalJob = startJob(
      registry,
      removedTerminalChild,
      1_000_000,
      "session_removed",
    );
    removedTerminalChild.emitExit(0, null);

    try {
      await registry.disposeSession("session_removed");

      expect(() =>
        registry.get(removedSessionJob.jobId, "session_removed"),
      ).toThrow("Unknown shell job");
      expect(() =>
        registry.get(removedTerminalJob.jobId, "session_removed"),
      ).toThrow("Unknown shell job");
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
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree,
    });
    const closedScopeJob = startJob(
      registry,
      closedScopeChild,
      1_000_000,
      "child_session",
      "subagent_1",
    );
    const siblingScopeJob = startJob(
      registry,
      siblingScopeChild,
      1_000_000,
      "child_session",
      "subagent_2",
    );

    try {
      await registry.disposeScope("child_session", "subagent_1");

      expect(() =>
        registry.get(closedScopeJob.jobId, "child_session", "subagent_1"),
      ).toThrow("Unknown shell job");
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
        createJobId: (): string => "job_1",
        killTree,
      });
      const started = startJob(registry, child, 10);

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

  it("keeps the lifecycle timeout active until close", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const killTree = vi.fn((): void => {
        child.emit("close", null, "SIGTERM");
      });
      const registry = new ShellJobRegistry({
        createJobId: (): string => "job_1",
        killTree,
      });
      const started = startJob(registry, child, 10);

      child.emitExitOnly(0, null);
      await vi.advanceTimersByTimeAsync(10);

      expect(killTree).toHaveBeenCalledTimes(1);
      expect(registry.get(started.jobId, "session_1").status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks task_output only for the current read", async () => {
    const child = new FakeChild();
    const registry = new ShellJobRegistry({
      createJobId: (): string => "job_1",
      killTree: vi.fn(),
    });
    const started = startJob(registry, child);
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
      createJobId: (): string => "job_1",
      killTree: vi.fn(),
    });
    const started = startJob(registry, child, 1_000_000);
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
        createJobId: (): string => "job_1",
        killTree: vi.fn(),
      });
      const started = startJob(registry, child, 10);

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
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree: (child): void => {
        (child as unknown as FakeChild).emit("close", null, "SIGTERM");
      },
    });
    const failed = startJob(registry, failedChild);
    const cancelled = startJob(registry, cancelledChild);

    failedChild.emitExit(1, null);
    const cancelledResult = await registry.kill(cancelled.jobId, "session_1");

    expect(registry.get(failed.jobId, "session_1").output).toBe(
      "Command failed with no output.",
    );
    expect(cancelledResult.output).toBe(
      "Command was cancelled with no output.",
    );
  });

  it("evicts the oldest terminal jobs after the retention limit", () => {
    let nextJobId = 0;
    const registry = new ShellJobRegistry({
      createJobId: (): string => `job_${String(++nextJobId)}`,
      killTree: vi.fn(),
    });

    for (let index = 0; index < 101; index += 1) {
      const child = new FakeChild();
      startJob(registry, child);
      child.emitExit(0, null);
    }

    expect(() => registry.get("job_1", "session_1")).toThrow(
      "Unknown shell job",
    );
    expect(registry.get("job_101", "session_1").status).toBe("completed");
  });

  it("evicts terminal jobs by completion order", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    try {
      let nextJobId = 0;
      const registry = new ShellJobRegistry({
        createJobId: (): string => `job_${String(++nextJobId)}`,
        killTree: vi.fn(),
      });
      const firstChild = new FakeChild();
      children.push(firstChild);
      const first = startJob(registry, firstChild, 1_000_000);
      const oldestTerminalChild = new FakeChild();
      children.push(oldestTerminalChild);
      const oldestTerminal = startJob(registry, oldestTerminalChild, 1_000_000);
      oldestTerminalChild.emitExit(0, null);
      for (let index = 0; index < 99; index += 1) {
        const child = new FakeChild();
        children.push(child);
        startJob(registry, child, 1_000_000);
      }

      firstChild.emitExit(0, null);

      expect(() => registry.get(oldestTerminal.jobId, "session_1")).toThrow(
        "Unknown shell job",
      );
      expect(registry.get(first.jobId, "session_1").status).toBe("completed");
    } finally {
      for (const child of children) {
        child.emitExit(0, null);
      }
      vi.useRealTimers();
    }
  });

  it("enforces session ownership and makes terminal kill idempotent", async () => {
    const child = new FakeChild();
    const killTree = vi.fn((): void => {
      child.emit("exit", 0, null);
    });
    const registry = new ShellJobRegistry({
      createJobId: (): string => "job_1",
      killTree,
    });
    const started = startJob(registry, child);
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
