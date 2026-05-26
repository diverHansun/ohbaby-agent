import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../manager.js";
import { AgentRegistry } from "../registry.js";
import type { AgentsConfig } from "../types.js";
import { AgentTaskManager } from "./manager.js";
import type {
  AgentPromptMessageBuilder,
  AgentRunCompletion,
  AgentRunCoordinator,
} from "../../core/agents/index.js";
import type { ChatCompletionMessage } from "../../core/llm-client/index.js";
import type {
  CoreMessage,
  MessageManager,
  MessageWithParts,
  Part,
} from "../../core/message/index.js";
import type { ToolDefinition } from "../../core/tool-scheduler/index.js";
import type { Session } from "../../services/session/index.js";

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
      build: ({ agent }): string => `system:${agent.name}`,
    },
  });
}

function createSessionManager(): {
  readonly create: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
} {
  const parent: Session = {
    agentName: "build",
    createdAt: 1,
    childrenIds: [],
    id: "parent",
    isSubagent: false,
    projectId: "project",
    projectRoot: "D:/repo",
    stats: { messageCount: 0 },
    status: "active",
    title: "Parent",
    updatedAt: 1,
  };
  const sessions = new Map<string, Session>([["parent", parent]]);
  let nextChild = 1;
  const create = vi.fn(
    (
      _projectDirectory: string,
      options: {
        readonly agentName?: string;
        readonly id?: string;
        readonly parentId?: string;
        readonly title?: string;
      } = {},
    ): Promise<Session> => {
      const child: Session = {
        agentName: options.agentName ?? "explore",
        createdAt: 1,
        childrenIds: [],
        id: options.id ?? `child_${String(nextChild++)}`,
        isSubagent: true,
        parentId: options.parentId,
        projectId: parent.projectId,
        projectRoot: parent.projectRoot,
        stats: { messageCount: 0 },
        status: "active",
        title: options.title ?? "Child",
        updatedAt: 1,
      };
      sessions.set(child.id, child);
      return Promise.resolve(child);
    },
  );
  const get = vi.fn(
    (sessionId: string): Promise<Session | null> =>
      Promise.resolve(sessions.get(sessionId) ?? null),
  );
  return { create, get };
}

function assistantText(sessionId: string, text: string): MessageWithParts {
  return {
    info: {
      agent: "explore",
      id: `assistant_${sessionId}`,
      role: "assistant",
      sessionId,
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${sessionId}`,
        messageId: `assistant_${sessionId}`,
        orderIndex: 0,
        sessionId,
        text,
        type: "text",
      },
    ],
  };
}

interface AgentRuntimeFixture {
  readonly buildPromptMessages: AgentPromptMessageBuilder;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly complete: (
    index: number,
    output: string,
    status?: AgentRunCompletion["status"],
  ) => void;
  readonly create: ReturnType<typeof vi.fn>;
  readonly messageManager: MessageManager;
  readonly runCoordinator: AgentRunCoordinator;
  readonly toolScheduler: {
    readonly getAvailableTools: ReturnType<typeof vi.fn>;
  };
}

function createAgentRuntime(): AgentRuntimeFixture {
  const controls: {
    readonly deferred: ReturnType<typeof deferred<AgentRunCompletion>>;
    output: string;
    readonly runId: string;
  }[] = [];
  const create = vi.fn<AgentRunCoordinator["create"]>((options) => {
    const runId = `run_${String(controls.length + 1)}`;
    controls.push({
      deferred: deferred<AgentRunCompletion>(),
      output: "",
      runId,
    });
    return Promise.resolve({
      createdAt: 1,
      disconnectMode: "continue",
      multitaskStrategy: "reject",
      permissionProfileId: "interactive",
      runId,
      sessionId: options.sessionId,
      status: "pending",
      triggerSource: "user",
    });
  });
  const cancel = vi.fn<AgentRunCoordinator["cancel"]>();
  const waitForCompletion = vi.fn<AgentRunCoordinator["waitForCompletion"]>(
    (runId): Promise<AgentRunCompletion> => {
      const control = controls.find((candidate) => candidate.runId === runId);
      if (!control) {
        return Promise.reject(new Error(`Unknown run: ${runId}`));
      }
      return control.deferred.promise;
    },
  );
  const createMessage = vi.fn<MessageManager["createMessage"]>(
    (input): Promise<CoreMessage> =>
      Promise.resolve({
        agent: input.role === "system" ? undefined : input.agent,
        id: `message_${String(createMessage.mock.calls.length + 1)}`,
        role: input.role,
        sessionId: input.sessionId,
        time: { created: 1 },
      } as CoreMessage),
  );
  const appendPart = vi.fn<MessageManager["appendPart"]>(
    (messageId, input): Promise<Part> =>
      Promise.resolve({
        id: `part_${messageId}`,
        messageId,
        orderIndex: 0,
        sessionId: "child_1",
        text: input.type === "tool" ? "" : input.text,
        type: input.type === "tool" ? "text" : input.type,
      }),
  );
  const latestOutputForSession = (_sessionId: string): string => {
    for (let index = controls.length - 1; index >= 0; index -= 1) {
      const output = controls[index]?.output;
      if (output) {
        return output;
      }
    }
    return "";
  };
  const getAvailableTools = vi.fn(
    (): Promise<ToolDefinition[]> => Promise.resolve([]),
  );
  return {
    buildPromptMessages: vi.fn(
      (): Promise<readonly ChatCompletionMessage[]> =>
        Promise.resolve([{ content: "system", role: "system" }]),
    ),
    cancel,
    complete(index, output, status = "succeeded"): void {
      const control = controls.at(index - 1);
      if (!control) {
        throw new Error(`Missing run ${String(index)}`);
      }
      control.output = output;
      control.deferred.resolve({ status });
    },
    create,
    messageManager: {
      appendPart,
      createMessage,
      listBySession: vi.fn<MessageManager["listBySession"]>((sessionId) => {
        const output = latestOutputForSession(sessionId);
        return Promise.resolve(output ? [assistantText(sessionId, output)] : []);
      }),
      removeMessage: vi.fn((): Promise<void> => Promise.resolve()),
      removeMessages: vi.fn((): Promise<void> => Promise.resolve()),
      toModelMessages: vi.fn((): Promise<ChatCompletionMessage[]> =>
        Promise.resolve([]),
      ),
      updateMessage: vi.fn((): Promise<CoreMessage> =>
        Promise.resolve({
          agent: "explore",
          id: "assistant",
          role: "assistant",
          sessionId: "child_1",
          time: { created: 1 },
        }),
      ),
      updatePart: vi.fn((): Promise<Part> =>
        Promise.resolve({
          id: "part",
          messageId: "assistant",
          orderIndex: 0,
          sessionId: "child_1",
          text: "updated",
          type: "text",
        }),
      ),
    },
    runCoordinator: {
      cancel,
      create,
      waitForCompletion,
    },
    toolScheduler: { getAvailableTools },
  };
}

async function createManager(input: {
  readonly createTaskId?: () => string;
  readonly maxTasksPerParent?: number;
  readonly runtime?: AgentRuntimeFixture;
} = {}): Promise<{
  readonly manager: AgentTaskManager;
  readonly runtime: AgentRuntimeFixture;
}> {
  const runtime = input.runtime ?? createAgentRuntime();
  return {
    manager: new AgentTaskManager({
      agentManager: await createAgentManager(),
      buildPromptMessages: runtime.buildPromptMessages,
      createTaskId: input.createTaskId,
      maxTasksPerParent: input.maxTasksPerParent,
      messageManager: runtime.messageManager,
      runCoordinator: runtime.runCoordinator,
      sessionManager: createSessionManager(),
      toolScheduler: runtime.toolScheduler,
    }),
    runtime,
  };
}

describe("AgentTaskManager", () => {
  it("opens a background task without waiting for the child run to finish", async () => {
    const { manager, runtime } = await createManager({
      createTaskId: () => "task_1",
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
    await vi.waitUntil(() => runtime.create.mock.calls.length === 1);
    expect(
      await manager.get({ parentSessionId: "parent", taskId: "task_1" }),
    ).toMatchObject({ status: "running" });

    runtime.complete(1, "done");
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
  });

  it("queues follow-up input while running and starts a second turn after completion", async () => {
    const { manager, runtime } = await createManager({
      createTaskId: () => "task_1",
    });
    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await vi.waitUntil(() => runtime.create.mock.calls.length === 1);

    await expect(
      manager.sendInput({
        parentSessionId: "parent",
        prompt: "second",
        taskId: "task_1",
      }),
    ).resolves.toMatchObject({ pendingInputCount: 1, status: "running" });

    runtime.complete(1, "first done");
    await vi.waitUntil(() => runtime.create.mock.calls.length === 2);
    runtime.complete(2, "second done");
    await vi.waitUntil(async () => {
      const current = await manager.get({
        parentSessionId: "parent",
        taskId: "task_1",
      });
      return current?.output === "second done";
    });
  });

  it("interrupts a running task and schedules the replacement input next", async () => {
    const { manager, runtime } = await createManager({
      createTaskId: () => "task_1",
    });
    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await vi.waitUntil(() => runtime.create.mock.calls.length === 1);

    await expect(
      manager.sendInput({
        interrupt: true,
        parentSessionId: "parent",
        prompt: "replacement",
        taskId: "task_1",
      }),
    ).resolves.toMatchObject({ pendingInputCount: 1, status: "running" });
    expect(runtime.cancel).toHaveBeenCalledWith(
      "run_1",
      "agent task interrupted",
    );

    runtime.complete(1, "interrupted", "cancelled");
    await vi.waitUntil(() => runtime.create.mock.calls.length === 2);
    runtime.complete(2, "replacement done");
    await vi.waitUntil(async () => {
      const current = await manager.get({
        parentSessionId: "parent",
        taskId: "task_1",
      });
      return current?.output === "replacement done";
    });
  });

  it("rejects control from a different parent session", async () => {
    const { manager } = await createManager({ createTaskId: () => "task_1" });
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
    const { manager, runtime } = await createManager({
      createTaskId: (() => {
        let next = 1;
        return (): string => `task_${String(next++)}`;
      })(),
      maxTasksPerParent: 1,
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
    runtime.complete(1, "cancelled", "cancelled");
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
    const { manager, runtime } = await createManager({
      createTaskId: () => "task_1",
    });

    await expect(
      manager.open({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "first",
        signal: abortController.signal,
      }),
    ).rejects.toThrow("Agent task open aborted");
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it("closes a running task by aborting its active child turn", async () => {
    const { manager, runtime } = await createManager({
      createTaskId: () => "task_1",
    });
    await manager.open({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "long",
    });
    await vi.waitUntil(() => runtime.create.mock.calls.length === 1);

    await expect(
      manager.close({ parentSessionId: "parent", taskId: "task_1" }),
    ).resolves.toMatchObject({
      previousStatus: "running",
      task: { status: "cancelled" },
    });
    expect(runtime.cancel).toHaveBeenCalledWith("run_1", "agent task closed");
  });
});
