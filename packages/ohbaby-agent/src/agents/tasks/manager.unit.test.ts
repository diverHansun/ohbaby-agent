import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../manager.js";
import { AgentRegistry } from "../registry.js";
import type {
  AgentsConfig,
  SubagentMessageWriter,
  SubagentRunner,
  SubagentSession,
  SubagentSessionManager,
} from "../types.js";
import { AgentTaskManager } from "./manager.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function createAgentManager(): Promise<AgentManager> {
  const registry = new AgentRegistry({
    configLoader: (): AgentsConfig => ({ agents: {} }),
  });
  await registry.initialize();
  return new AgentManager({
    registry,
    systemPromptProvider: {
      build: ({ agent }) => `system:${agent.name}`,
    },
  });
}

function createSessionManager(): SubagentSessionManager {
  const parent: SubagentSession = {
    agentName: "build",
    childrenIds: [],
    id: "parent",
    isSubagent: false,
    projectRoot: "D:/repo",
  };
  const sessions = new Map<string, SubagentSession>([["parent", parent]]);
  let nextChild = 1;
  return {
    create(_projectDirectory, options): Promise<SubagentSession> {
      const child: SubagentSession = {
        agentName: options?.agentName ?? "explore",
        childrenIds: [],
        id: `child_${String(nextChild++)}`,
        isSubagent: true,
        parentId: options?.parentId,
        projectRoot: parent.projectRoot,
      };
      sessions.set(child.id, child);
      return Promise.resolve(child);
    },
    get(sessionId): Promise<SubagentSession | null> {
      return Promise.resolve(sessions.get(sessionId) ?? null);
    },
  };
}

describe("AgentTaskManager", () => {
  it("opens a background task without waiting for the child run to finish", async () => {
    const completion = deferred<{
      readonly output: string;
      readonly success: true;
    }>();
    const run = vi.fn<SubagentRunner["run"]>(
      (): Promise<{ readonly output: string; readonly success: true }> =>
        completion.promise,
    );
    const runner: SubagentRunner = {
      run,
    };
    const writeUserMessage = vi.fn<SubagentMessageWriter["writeUserMessage"]>(
      () => Promise.resolve({ messageId: "message_user" }),
    );
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: () => "task_1",
      messageWriter: { writeUserMessage },
      runner,
      sessionManager: createSessionManager(),
      now: (() => {
        let value = 100;
        return (): number => (value += 1);
      })(),
    });

    const task = await manager.open({
      agentName: "explore",
      description: "Explore files",
      parentSessionId: "parent",
      prompt: "Find auth",
    });

    expect(task).toMatchObject({
      sessionId: "child_1",
      status: "pending",
      taskId: "task_1",
    });
    await vi.waitUntil(() => run.mock.calls.length === 1);
    expect(
      await manager.get({ parentSessionId: "parent", taskId: "task_1" }),
    ).toMatchObject({ status: "running" });

    completion.resolve({ output: "done", success: true });
    await vi.waitUntil(async () => {
      const current = await manager.get({
        parentSessionId: "parent",
        taskId: "task_1",
      });
      return current?.status === "completed";
    });
    expect(
      await manager.get({ parentSessionId: "parent", taskId: "task_1" }),
    ).toMatchObject({ output: "done", status: "completed" });
    expect(writeUserMessage).toHaveBeenCalledWith({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "Find auth",
      sessionId: "child_1",
    });
  });

  it("queues follow-up input while running and starts a second turn after completion", async () => {
    const first = deferred<{
      readonly output: string;
      readonly success: true;
    }>();
    const second = deferred<{
      readonly output: string;
      readonly success: true;
    }>();
    const run = vi
      .fn<SubagentRunner["run"]>()
      .mockImplementationOnce(
        (): Promise<{ readonly output: string; readonly success: true }> =>
          first.promise,
      )
      .mockImplementationOnce(
        (): Promise<{ readonly output: string; readonly success: true }> =>
          second.promise,
      );
    const runner: SubagentRunner = {
      run,
    };
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: () => "task_1",
      messageWriter: {
        writeUserMessage: vi.fn(() => Promise.resolve({ messageId: "msg" })),
      },
      runner,
      sessionManager: createSessionManager(),
    });

    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await vi.waitUntil(() => run.mock.calls.length === 1);

    await expect(
      manager.sendInput({
        parentSessionId: "parent",
        prompt: "second",
        taskId: "task_1",
      }),
    ).resolves.toMatchObject({ pendingInputCount: 1, status: "running" });

    first.resolve({ output: "first done", success: true });
    await vi.waitUntil(() => run.mock.calls.length === 2);
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: "second", sessionId: "child_1" }),
    );
    second.resolve({ output: "second done", success: true });
    await vi.waitUntil(async () => {
      const current = await manager.get({
        parentSessionId: "parent",
        taskId: "task_1",
      });
      return current?.output === "second done";
    });
  });

  it("interrupts a running task and schedules the replacement input next", async () => {
    const first = deferred<{
      readonly output: string;
      readonly success: false;
    }>();
    const second = deferred<{
      readonly output: string;
      readonly success: true;
    }>();
    let firstSignal: AbortSignal | undefined;
    const run = vi
      .fn<SubagentRunner["run"]>()
      .mockImplementationOnce(
        ({
          signal,
        }): Promise<{
          readonly output: string;
          readonly success: false;
        }> => {
          firstSignal = signal;
          signal?.addEventListener("abort", () => {
            first.resolve({ output: "interrupted", success: false });
          });
          return first.promise;
        },
      )
      .mockImplementationOnce(
        (): Promise<{ readonly output: string; readonly success: true }> =>
          second.promise,
      );
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: () => "task_1",
      messageWriter: {
        writeUserMessage: vi.fn(() => Promise.resolve({ messageId: "msg" })),
      },
      runner: { run },
      sessionManager: createSessionManager(),
    });

    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await vi.waitUntil(() => run.mock.calls.length === 1);

    await expect(
      manager.sendInput({
        interrupt: true,
        parentSessionId: "parent",
        prompt: "replacement",
        taskId: "task_1",
      }),
    ).resolves.toMatchObject({ pendingInputCount: 1, status: "running" });
    expect(firstSignal?.aborted).toBe(true);

    await vi.waitUntil(() => run.mock.calls.length === 2);
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: "replacement", sessionId: "child_1" }),
    );
    second.resolve({ output: "replacement done", success: true });
    await vi.waitUntil(async () => {
      const current = await manager.get({
        parentSessionId: "parent",
        taskId: "task_1",
      });
      return current?.output === "replacement done";
    });
  });

  it("rejects control from a different parent session", async () => {
    const runner: SubagentRunner = {
      run: vi.fn(() => Promise.resolve({ output: "done", success: true })),
    };
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: () => "task_1",
      messageWriter: {
        writeUserMessage: vi.fn(() => Promise.resolve({ messageId: "msg" })),
      },
      runner,
      sessionManager: createSessionManager(),
    });

    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });

    await expect(
      manager.sendInput({
        parentSessionId: "other_parent",
        prompt: "steal",
        taskId: "task_1",
      }),
    ).rejects.toThrow("Agent task not found: task_1");
    await expect(
      manager.get({ parentSessionId: "other_parent", taskId: "task_1" }),
    ).resolves.toBeNull();
    await expect(
      manager.close({ parentSessionId: "other_parent", taskId: "task_1" }),
    ).rejects.toThrow("Agent task not found: task_1");
  });

  it("limits retained background tasks until one is closed", async () => {
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: (() => {
        let next = 1;
        return (): string => `task_${String(next++)}`;
      })(),
      maxTasksPerParent: 1,
      messageWriter: {
        writeUserMessage: vi.fn(() => Promise.resolve({ messageId: "msg" })),
      },
      runner: {
        run: vi.fn(() => Promise.resolve({ output: "done", success: true })),
      },
      sessionManager: createSessionManager(),
    });

    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await expect(
      manager.open({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "second",
      }),
    ).rejects.toThrow("Too many retained agent tasks for this session");

    await manager.close({ parentSessionId: "parent", taskId: "task_1" });
    await expect(
      manager.open({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "second",
      }),
    ).resolves.toMatchObject({ taskId: "task_2" });
  });

  it("does not start a background child run when open is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const run = vi.fn<SubagentRunner["run"]>();
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: () => "task_1",
      messageWriter: {
        writeUserMessage: vi.fn(() => Promise.resolve({ messageId: "msg" })),
      },
      runner: { run },
      sessionManager: createSessionManager(),
    });

    await expect(
      manager.open({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "first",
        signal: abortController.signal,
      }),
    ).rejects.toThrow("Agent task open aborted");
    expect(run).not.toHaveBeenCalled();
  });

  it("closes a running task by aborting its active child turn", async () => {
    const blocked = deferred<{
      readonly output: string;
      readonly success: false;
    }>();
    const run = vi.fn<SubagentRunner["run"]>(
      ({
        signal,
      }): Promise<{
        readonly output: string;
        readonly success: false;
      }> => {
        signal?.addEventListener("abort", () => {
          blocked.resolve({ output: "cancelled", success: false });
        });
        return blocked.promise;
      },
    );
    const runner: SubagentRunner = {
      run,
    };
    const manager = new AgentTaskManager({
      agentManager: await createAgentManager(),
      createTaskId: () => "task_1",
      messageWriter: {
        writeUserMessage: vi.fn(() => Promise.resolve({ messageId: "msg" })),
      },
      runner,
      sessionManager: createSessionManager(),
    });
    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "long",
    });
    await vi.waitUntil(() => run.mock.calls.length === 1);

    await expect(
      manager.close({ parentSessionId: "parent", taskId: "task_1" }),
    ).resolves.toMatchObject({
      previousStatus: "running",
      task: { status: "cancelled" },
    });
    await vi.waitUntil(async () => {
      const current = await manager.get({
        parentSessionId: "parent",
        taskId: "task_1",
      });
      return current?.status === "cancelled";
    });
  });
});
