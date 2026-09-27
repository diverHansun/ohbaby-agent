import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import { createToolScheduler } from "../core/tool-scheduler/index.js";
import type {
  ToolCallRequest,
  ToolExecutionFact,
} from "../core/tool-scheduler/types.js";
import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import { createPermissionState } from "../permission/index.js";
import { createHostLocalEnvironment } from "../adapters/ui-runtime/host-local-environment.js";
import { createBashTool } from "./bash.js";
import {
  ShellJobRegistry,
  createTaskKillTool,
  createTaskOutputTool,
} from "./shell-job-registry.js";

class Child extends EventEmitter {
  readonly pid = 424242;
  readonly stdin = { end: vi.fn() };
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stopped = false;
  finish(): void {
    this.stopped = true;
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

function fixture(
  options: { createJobId?: () => string; stdinEndError?: Error } = {},
): {
  scheduler: ReturnType<typeof createToolScheduler>;
  registry: ShellJobRegistry;
  children: Child[];
  facts: ToolExecutionFact[];
  killTree: ReturnType<typeof vi.fn<() => Promise<void>>>;
  independentExecute: ReturnType<typeof vi.fn<() => { output: string }>>;
  request(
    callId: string,
    overrides?: Partial<ToolCallRequest>,
  ): ToolCallRequest;
  dispose(): Promise<void>;
} {
  const children: Child[] = [];
  const facts: ToolExecutionFact[] = [];
  const killTree = vi.fn(
    () =>
      new Promise<void>(() => {
        /* The test deliberately never confirms termination through this helper. */
      }),
  );
  const registry = new ShellJobRegistry({
    createJobId: options.createJobId,
    killTree,
    probeTree: (child): "stopped" | "running" =>
      (child as unknown as Child).stopped ? "stopped" : "running",
    cleanupObservationMs: 50,
  });
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { concurrency: { maxConcurrency: 1 } },
    resolveOwner: (request) => ({
      ...request,
      workspaceKey: "bash-integration",
      rootSessionId: request.sessionId.startsWith("child")
        ? "root"
        : request.sessionId,
    }),
    onExecutionFact: (fact) => {
      facts.push(fact);
    },
  });
  const bash = createBashTool({
    registry,
    shell: { acceptable: () => "/bin/sh", killTree },
    preflight: () => Promise.resolve({ cdTargets: [], resolvedPaths: [] }),
    spawn: () => {
      const child = new Child();
      const stdinEndError = options.stdinEndError;
      if (stdinEndError)
        child.stdin.end.mockImplementationOnce(() => {
          throw stdinEndError;
        });
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  scheduler.register(bash);
  scheduler.register(createTaskKillTool(registry));
  scheduler.register(createTaskOutputTool(registry));
  const independentExecute = vi.fn(() => ({ output: "independent" }));
  scheduler.register(
    withToolAdmission(
      {
        name: "network_probe",
        description: "Independent network work",
        source: "builtin",
        category: "network",
        parametersJsonSchema: {},
        execute: independentExecute,
      },
      { plan: () => [] },
    ),
  );
  const request = (
    callId: string,
    overrides: Partial<ToolCallRequest> = {},
  ): ToolCallRequest => ({
    callId,
    sessionId: "root",
    runId: "run-1",
    messageId: "message",
    toolName: "bash",
    params: { command: "echo fixture" },
    environment: createHostLocalEnvironment(),
    ...overrides,
  });
  return {
    scheduler,
    registry,
    children,
    facts,
    killTree,
    independentExecute,
    request,
    async dispose(): Promise<void> {
      children.forEach((child) => {
        child.finish();
      });
      await registry.dispose();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("Bash cleanup through scheduler", () => {
  it("hands off cancellation before an unresolved kill, errors queued/new source work, and recovers without replay", async () => {
    const f = fixture();
    const controller = new AbortController();
    const first = f.scheduler.execute(
      f.request("old", { signal: controller.signal }),
    );
    try {
      await expect.poll(() => f.children.length).toBe(1);
      const independent = f.scheduler.execute(
        f.request("network", { toolName: "network_probe", params: {} }),
      );
      await expect
        .poll(() =>
          f.facts.some(
            (fact) =>
              fact.owner.callId === "network" && fact.reason === "capacity",
          ),
        )
        .toBe(true);
      vi.useFakeTimers();
      controller.abort();
      expect((await first).status).toBe("cancelled");
      expect((await independent).status).toBe("success");
      expect(f.killTree).toHaveBeenCalledTimes(1);
      const queued = f.scheduler.execute(
        f.request("queued", { sessionId: "child-old", runId: "run-2" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.facts.some(
          (fact) =>
            fact.owner.callId === "queued" && fact.reason === "source-cleanup",
        ),
      ).toBe(true);
      expect(f.children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(50);
      expect((await queued).error?.message).toContain("unconfirmed");
      for (const sessionId of ["root", "child-new"]) {
        const result = await f.scheduler.execute(
          f.request(`rejected-${sessionId}`, { sessionId, runId: "run-3" }),
        );
        expect(result.error?.message).toContain("unconfirmed");
      }
      expect(
        f.facts
          .filter((fact) => fact.phase === "started")
          .map((fact) => fact.owner.callId),
      ).toEqual(["old", "network"]);
      const other = await f.scheduler.execute(
        f.request("other", {
          sessionId: "other",
          params: { command: "echo other", run_in_background: true },
        }),
      );
      expect(other.status).toBe("success");
      expect(f.children).toHaveLength(2);
      f.children[0].finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.children).toHaveLength(2);
      const recovered = await f.scheduler.execute(
        f.request("recovered", {
          runId: "run-4",
          params: { command: "echo recovered", run_in_background: true },
        }),
      );
      expect(recovered.status).toBe("success");
      expect(f.children).toHaveLength(3);
      expect(
        f.facts.filter(
          (fact) => fact.owner.callId === "old" && fact.phase === "settled",
        ),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it("keeps normal background jobs unrestricted, preserves controls, and confirms two residues independently", async () => {
    const f = fixture();
    try {
      const jobs = [];
      for (const callId of ["background-1", "background-2"]) {
        const result = await f.scheduler.execute(
          f.request(callId, {
            params: { command: "echo background", run_in_background: true },
          }),
        );
        expect(result.status).toBe("success");
        jobs.push(result.metadata?.jobId);
      }
      expect(f.children).toHaveLength(2);
      vi.useFakeTimers();
      for (const jobId of jobs) {
        const killed = await f.scheduler.execute(
          f.request(`kill-${String(jobId)}`, {
            toolName: "task_kill",
            params: { job_id: jobId },
          }),
        );
        expect(killed.status).toBe("success");
      }
      await vi.advanceTimersByTimeAsync(50);
      for (const jobId of jobs) {
        const output = await f.scheduler.execute(
          f.request(`output-${String(jobId)}`, {
            toolName: "task_output",
            params: { job_id: jobId },
          }),
        );
        expect(output.metadata).toMatchObject({
          status: "cancelled",
          cleanup: "unconfirmed",
        });
        expect(
          (
            await f.scheduler.execute(
              f.request(`again-${String(jobId)}`, {
                toolName: "task_kill",
                params: { job_id: jobId },
              }),
            )
          ).status,
        ).toBe("success");
      }
      expect(f.killTree).toHaveBeenCalledTimes(2);
      f.children[1].finish();
      const stillBlocked = await f.scheduler.execute(
        f.request("still-blocked"),
      );
      expect(stillBlocked.error?.message).toContain("unconfirmed");
      f.children[0].finish();
      const resumed = await f.scheduler.execute(
        f.request("resumed", {
          params: { command: "echo resumed", run_in_background: true },
        }),
      );
      expect(resumed.status).toBe("success");
      expect(f.children).toHaveLength(3);
      expect(
        f.facts.filter(
          (fact) =>
            fact.phase === "started" && fact.owner.callId === "still-blocked",
        ),
      ).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  });
  it("background timeout starts one fixed observation budget and keeps the original dispatch result", async () => {
    const f = fixture();
    vi.useFakeTimers();
    try {
      const dispatch = await f.scheduler.execute(
        f.request("dispatch", {
          params: {
            command: "echo fixture",
            run_in_background: true,
            timeout: 10,
          },
        }),
      );
      expect(dispatch.status).toBe("success");
      const jobId = dispatch.metadata?.jobId;
      await vi.advanceTimersByTimeAsync(10);
      const queued = f.scheduler.execute(
        f.request("after-timeout", { runId: "later-run" }),
      );
      await vi.advanceTimersByTimeAsync(30);
      const [query] = await f.scheduler.executeBatch({
        calls: [
          f.request("query", {
            toolName: "task_output",
            params: { job_id: jobId },
          }),
        ],
        observer: {
          onCallState: () => Promise.resolve(),
          onCallSettled: () => Promise.resolve(),
        },
      });
      expect(query.execution?.outcome).toBe("success");
      expect(query.metadata).toMatchObject({
        status: "timed_out",
        cleanup: "in-progress",
      });
      const unauthorized = await f.scheduler.execute(
        f.request("unauthorized", {
          sessionId: "child-old",
          toolName: "task_output",
          params: { job_id: jobId },
        }),
      );
      expect(unauthorized.error?.message).toContain("not owned");
      await vi.advanceTimersByTimeAsync(20);
      expect((await queued).error?.message).toContain("unconfirmed");
      expect(f.killTree).toHaveBeenCalledTimes(1);
      expect(dispatch.metadata?.status).toBe("running");
      expect(
        f.facts.filter(
          (fact) =>
            fact.owner.callId === "dispatch" && fact.phase === "settled",
        ),
      ).toHaveLength(1);
      expect(f.children).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });
  it("does not spawn or leak environment retention when job identity allocation fails", async () => {
    const f = fixture({
      createJobId: () => {
        throw new Error("identity allocation failed");
      },
    });
    const release = vi.fn();
    const retain = vi.fn(() => release);
    try {
      const result = await f.scheduler.execute(
        f.request("identity-failure", {
          environment: { ...createHostLocalEnvironment(), retain },
        }),
      );
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("identity allocation failed");
      expect.soft(f.children).toHaveLength(0);
      expect.soft(release).toHaveBeenCalledTimes(retain.mock.calls.length);
      expect(f.killTree).not.toHaveBeenCalled();
      expect(f.registry.hasActiveWork()).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it("does not spawn when Bash retention synchronously cancels the call", async () => {
    const f = fixture();
    const controller = new AbortController();
    const release = vi.fn();
    let retainCount = 0;
    const retain = vi.fn(() => {
      retainCount += 1;
      // First retain belongs to scheduler; the second transfers process ownership.
      if (retainCount === 2) controller.abort();
      return release;
    });
    try {
      const result = await f.scheduler.execute(
        f.request("retention-cancel", {
          signal: controller.signal,
          environment: { ...createHostLocalEnvironment(), retain },
        }),
      );
      expect(result.status).toBe("cancelled");
      expect(retain).toHaveBeenCalledTimes(2);
      expect.soft(f.children).toHaveLength(0);
      expect.soft(release).toHaveBeenCalledTimes(2);
      expect.soft(f.killTree).not.toHaveBeenCalled();
      expect.soft(f.registry.hasActiveWork()).toBe(false);
    } finally {
      await f.dispose();
    }
  });
  it("owns and cleans a launched child when closing stdin throws", async () => {
    const f = fixture({ stdinEndError: new Error("stdin end failed") });
    const release = vi.fn();
    const retain = vi.fn(() => release);
    try {
      const result = await f.scheduler.execute(
        f.request("stdin-failure", {
          environment: { ...createHostLocalEnvironment(), retain },
        }),
      );
      expect(f.children).toHaveLength(1);
      expect(f.killTree).toHaveBeenCalledTimes(1);
      expect(f.registry.hasActiveWork()).toBe(true);
      expect(result.metadata).toMatchObject({
        status: "cancelled",
        cleanup: "in-progress",
        error: "stdin end failed",
      });
      expect(retain).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(1);
      expect(
        f.registry.get(String(result.metadata?.jobId), "root").metadata.cleanup,
      ).toBe("in-progress");
      f.children[0].finish();
      await Promise.resolve();
      expect(release).toHaveBeenCalledTimes(2);
      expect(f.registry.hasActiveWork()).toBe(false);
    } finally {
      await f.dispose();
    }
  });
});
