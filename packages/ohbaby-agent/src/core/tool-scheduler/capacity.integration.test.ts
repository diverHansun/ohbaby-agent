import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import {
  createTaskKillTool,
  createTaskOutputTool,
  ShellJobRegistry,
} from "../../tools/shell-job-registry.js";
import { createToolScheduler, ToolSchedulerEvent } from "./index.js";
import { withToolAdmission } from "./tool-admission.js";
import type { CapacityKind } from "./concurrency.js";
import type {
  Tool,
  ToolCallRequest,
  ToolExecutionResult,
  ToolSchedulerOptions,
} from "./types.js";

function request(
  callId: string,
  toolName: string,
  sessionId = "parent",
): ToolCallRequest {
  return {
    callId,
    toolName,
    sessionId,
    messageId: `message-${callId}`,
    params: {},
  };
}

function fixture(config?: ToolSchedulerOptions["config"]): {
  scheduler: ReturnType<typeof createToolScheduler>;
  started: string[];
  register(
    name: string,
    category: Tool["category"],
    capacity?: CapacityKind,
  ): void;
  release(callId: string): void;
  finish(): void;
} {
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    config,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    permission: { ask: () => Promise.resolve("once") },
  });
  const started: string[] = [];
  const pending = new Map<string, (result: ToolExecutionResult) => void>();
  let finished = false;
  bus.subscribe(ToolSchedulerEvent.ExecutionStarted, ({ callId }) => {
    started.push(callId);
  });
  return {
    scheduler,
    started,
    register(name, category, capacity): void {
      const tool: Tool = {
        name,
        category,
        source: "builtin",
        description: "Controlled real scheduler integration fixture",
        parametersJsonSchema: {},
        execute: (_params, context): Promise<ToolExecutionResult> =>
          finished
            ? Promise.resolve({ output: "released" })
            : new Promise((resolve) => {
                pending.set(context.callId, resolve);
              }),
      };
      // The internal capability registry is keyed by this actual implementation.
      // Omitting capacity deliberately leaves spoofed names/categories ordinary.
      scheduler.register(withToolAdmission(tool, { capacity, plan: () => [] }));
    },
    release(callId): void {
      pending.get(callId)?.({ output: "released" });
      pending.delete(callId);
    },
    finish(): void {
      finished = true;
      for (const resolve of pending.values()) {
        resolve({ output: "released" });
      }
      pending.clear();
      scheduler.cancelAll();
    },
  };
}

describe("real scheduler session capacity", () => {
  it("shares the default ten ordinary slots across mixed categories and queues the eleventh", async () => {
    const f = fixture();
    const categories: Tool["category"][] = [
      "readonly",
      "write",
      "dangerous",
      "network",
      "memory",
      "skill",
      "subagent-control",
    ];
    const calls = Array.from({ length: 11 }, (_, index) => {
      const name = `mixed_${String(index)}`;
      f.register(name, categories[index % categories.length], "ordinary");
      return request(`mixed-${String(index)}`, name);
    });
    const run = f.scheduler.executeBatch({ calls });
    try {
      await vi.waitFor(() => {
        expect(f.started).toHaveLength(10);
      });
      expect(f.started).not.toContain("mixed-10");
      expect(f.scheduler.getStatus("mixed-10")).toBe("queued");
      f.release("mixed-0");
      await vi.waitFor(() => {
        expect(f.started).toHaveLength(11);
      });
      expect(f.started).toContain("mixed-10");
    } finally {
      f.finish();
      await run;
    }
  });

  it("keeps a session's limit across batches while independent main and child sessions proceed", async () => {
    const f = fixture({ concurrency: { maxConcurrency: 1 } });
    f.register("work", "write", "ordinary");
    const first = f.scheduler.executeBatch({
      calls: [request("first", "work")],
    });
    const runs: Promise<unknown>[] = [first];
    try {
      await vi.waitFor(() => {
        expect(f.started).toContain("first");
      });
      runs.push(
        f.scheduler.executeBatch({ calls: [request("next-batch", "work")] }),
      );
      runs.push(
        f.scheduler.execute(request("independent", "work", "another-main")),
      );
      runs.push(
        f.scheduler.execute({
          ...request("child", "work", "child-session"),
          isSubagent: true,
        }),
      );
      await vi.waitFor(() => {
        expect(f.started).toEqual(
          expect.arrayContaining(["first", "independent", "child"]),
        );
      });
      expect(f.started).not.toContain("next-batch");
      expect(f.scheduler.getStatus("next-batch")).toBe("queued");
      f.release("first");
      await vi.waitFor(() => {
        expect(f.started).toContain("next-batch");
      });
    } finally {
      f.finish();
      await Promise.all(runs);
    }
  });

  it("keeps three trusted dispatch slots independent from the parent's ordinary limit", async () => {
    const f = fixture({ concurrency: { maxConcurrency: 1 } });
    f.register("ordinary", "readonly", "ordinary");
    f.register("subagent_run", "subagent", "dispatch");
    const runs = [f.scheduler.execute(request("ordinary-running", "ordinary"))];
    try {
      await vi.waitFor(() => {
        expect(f.started).toContain("ordinary-running");
      });
      for (let index = 0; index < 4; index += 1) {
        runs.push(
          f.scheduler.execute(
            request(`dispatch-${String(index)}`, "subagent_run"),
          ),
        );
      }
      runs.push(f.scheduler.execute(request("ordinary-waiting", "ordinary")));
      runs.push(
        f.scheduler.execute(request("other-dispatch", "subagent_run", "other")),
      );
      await vi.waitFor(() => {
        expect(f.started).toHaveLength(5);
      });
      expect(f.started).toEqual(
        expect.arrayContaining([
          "ordinary-running",
          "dispatch-0",
          "dispatch-1",
          "dispatch-2",
          "other-dispatch",
        ]),
      );
      expect(f.started).not.toContain("dispatch-3");
      expect(f.started).not.toContain("ordinary-waiting");
      f.release("dispatch-0");
      await vi.waitFor(() => {
        expect(f.started).toContain("dispatch-3");
      });
      expect(f.started).not.toContain("ordinary-waiting");
      f.release("ordinary-running");
      await vi.waitFor(() => {
        expect(f.started).toContain("ordinary-waiting");
      });
    } finally {
      f.finish();
      await Promise.all(runs);
    }
  });

  it.each([
    ["task_output", "subagent-control"],
    ["task_kill", "memory"],
    ["subagent_run", "subagent"],
  ] as const)(
    "does not exempt an untrusted implementation named %s with category %s",
    async (name, category) => {
      const f = fixture({ concurrency: { maxConcurrency: 1 } });
      f.register("ordinary", "readonly", "ordinary");
      f.register(name, category);
      const runs = [
        f.scheduler.execute(request("ordinary-running", "ordinary")),
      ];
      try {
        await vi.waitFor(() => {
          expect(f.started).toContain("ordinary-running");
        });
        runs.push(
          f.scheduler.execute({
            ...request("spoof", name),
            params: { capacity: "control", isTrusted: true },
          }),
        );
        await vi.waitFor(() => {
          expect(f.scheduler.getStatus("spoof")).toBe("queued");
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(f.started).not.toContain("spoof");
        f.release("ordinary-running");
        await vi.waitFor(() => {
          expect(f.started).toContain("spoof");
        });
      } finally {
        f.finish();
        await Promise.all(runs);
      }
    },
  );

  it("admits the real task_output and task_kill tools while ordinary capacity is full", async () => {
    const f = fixture({ concurrency: { maxConcurrency: 1 } });
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('capacity-job')"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    const registry = new ShellJobRegistry({
      killTree: (process): void => {
        process.kill();
      },
    });
    const job = registry.start({ child, sessionId: "parent", timeoutMs: 5000 });
    const runs: Promise<unknown>[] = [];
    try {
      await closed;
      f.register("ordinary", "readonly", "ordinary");
      f.scheduler.register(createTaskOutputTool(registry));
      f.scheduler.register(createTaskKillTool(registry));
      runs.push(f.scheduler.execute(request("ordinary-running", "ordinary")));
      await vi.waitFor(() => {
        expect(f.started).toContain("ordinary-running");
      });
      for (const name of ["task_output", "task_kill"]) {
        const result = f.scheduler.execute({
          ...request(name, name),
          params: { job_id: job.jobId },
        });
        runs.push(result);
        await vi.waitFor(() => {
          expect(f.started).toContain(name);
        });
        expect(await result).toMatchObject({
          status: "success",
          output: "capacity-job",
        });
        expect(f.scheduler.getStatus("ordinary-running")).toBe("executing");
      }
    } finally {
      f.finish();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
      await Promise.all(runs);
    }
  });
});
