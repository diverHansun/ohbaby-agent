import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./service.js";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type { AgentsConfig } from "./types.js";
import type {
  AgentPromptMessageBuilder,
  AgentRunCoordinator,
} from "../core/agents/index.js";
import type { ChatCompletionMessage } from "../core/llm-client/index.js";
import type {
  CoreMessage,
  MessageManager,
  MessageWithParts,
  Part,
} from "../core/message/index.js";
import type {
  ToolDefinition,
  ToolSchedulerInstance,
} from "../core/tool-scheduler/index.js";
import type { Session } from "../services/session/index.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function createAgentManager(): Promise<AgentManager> {
  const registry = new AgentRegistry({
    configLoader: (): AgentsConfig => ({
      agents: {
        universal: {
          description: "Primary or subagent",
          mode: "all",
          name: "universal",
          tools: { include: ["read", "task", "todo_read"] },
        },
      },
    }),
  });
  await registry.initialize();
  return new AgentManager({
    registry,
    systemPromptProvider: {
      build: ({ agent }) => `system:${agent.name}`,
    },
  });
}

function createSessionManager(): {
  readonly create: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
} {
  const parent: Session = {
    agentName: "build",
    childrenIds: [],
    createdAt: 1,
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
        readonly id?: string;
        readonly title?: string;
        readonly agentName?: string;
        readonly parentId?: string;
      } = {},
    ): Promise<Session> => {
      const session: Session = {
        agentName: options.agentName ?? "default",
        childrenIds: [],
        createdAt: 1,
        id: options.id ?? `child_${String(nextChild++)}`,
        isSubagent: options.parentId !== undefined,
        parentId: options.parentId,
        projectId: parent.projectId,
        projectRoot: "D:/repo",
        stats: { messageCount: 0 },
        status: "active",
        title: options.title ?? "Child",
        updatedAt: 1,
      };
      sessions.set(session.id, session);
      return Promise.resolve(session);
    },
  );
  const get = vi.fn(
    (sessionId: string): Promise<Session | null> =>
      Promise.resolve(sessions.get(sessionId) ?? null),
  );
  return { create, get };
}

function assistantText(text: string): MessageWithParts {
  return {
    info: {
      agent: "explore",
      id: "assistant",
      role: "assistant",
      sessionId: "child_1",
      time: { created: 1 },
    },
    parts: [
      {
        id: "part_1",
        messageId: "assistant",
        orderIndex: 0,
        sessionId: "child_1",
        text,
        type: "text",
      },
    ],
  };
}

function createMessageManager(
  messages: readonly MessageWithParts[] = [assistantText("exploration complete")],
): {
  readonly appendPart: ReturnType<typeof vi.fn>;
  readonly createMessage: ReturnType<typeof vi.fn>;
  readonly manager: MessageManager;
} {
  const createMessage = vi.fn<MessageManager["createMessage"]>(
    (input): Promise<CoreMessage> =>
      Promise.resolve({
        agent: input.role === "system" ? undefined : input.agent,
        id: "message_child",
        role: input.role,
        sessionId: input.sessionId,
        time: { created: 1 },
      } as CoreMessage),
  );
  const appendPart = vi.fn<MessageManager["appendPart"]>(
    (messageId, input): Promise<Part> =>
      Promise.resolve({
        id: "part_user",
        messageId,
        orderIndex: 0,
        sessionId: "child_1",
        text: input.type === "tool" ? "" : input.text,
        type: input.type === "tool" ? "text" : input.type,
      }),
  );
  return {
    appendPart,
    createMessage,
    manager: {
      appendPart,
      createMessage,
      listBySession: vi.fn((): Promise<MessageWithParts[]> => Promise.resolve([...messages])),
      removeMessage: vi.fn((): Promise<void> => Promise.resolve()),
      removeMessages: vi.fn((): Promise<void> => Promise.resolve()),
      toModelMessages: vi.fn((): Promise<ChatCompletionMessage[]> => Promise.resolve([])),
      updateMessage: vi.fn((): Promise<CoreMessage> => Promise.resolve({
        agent: "explore",
        id: "assistant",
        role: "assistant",
        sessionId: "child_1",
        time: { created: 1 },
      })),
      updatePart: vi.fn((): Promise<Part> => Promise.resolve({
        id: "part",
        messageId: "assistant",
        orderIndex: 0,
        sessionId: "child_1",
        text: "updated",
        type: "text",
      })),
    },
  };
}

function createRunCoordinator(
  completion: Awaited<ReturnType<AgentRunCoordinator["waitForCompletion"]>> = {
    status: "succeeded",
  },
): {
  readonly coordinator: AgentRunCoordinator;
  readonly create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn<AgentRunCoordinator["create"]>(() =>
    Promise.resolve({
      runId: "run_child",
      sessionId: "child_1",
    }),
  );
  return {
    coordinator: {
      cancel: vi.fn(),
      create,
      waitForCompletion: vi.fn(() => Promise.resolve(completion)),
    },
    create,
  };
}

function createToolScheduler(): {
  readonly getAvailableTools: ReturnType<typeof vi.fn>;
  readonly scheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
} {
  const readTool: ToolDefinition = {
    category: "readonly",
    description: "Read files",
    name: "read",
    parameters: { type: "object" },
    source: "builtin",
  };
  const getAvailableTools = vi.fn(
    (): Promise<ToolDefinition[]> => Promise.resolve([readTool]),
  );
  return {
    getAvailableTools,
    scheduler: { getAvailableTools },
  };
}

function createPromptBuilder(): AgentPromptMessageBuilder {
  return vi.fn(
    (): Promise<readonly ChatCompletionMessage[]> =>
      Promise.resolve([{ content: "system", role: "system" }]),
  );
}

describe("AgentService", () => {
  it("creates an isolated child session, writes the prompt, and runs through core runAgent", async () => {
    const messages = createMessageManager();
    const runs = createRunCoordinator();
    const tools = createToolScheduler();
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: messages.manager,
      now: (() => {
        let value = 1_000;
        return (): number => (value += 100);
      })(),
      runCoordinator: runs.coordinator,
      sessionManager: createSessionManager(),
      toolScheduler: tools.scheduler,
    });

    await expect(
      service.execute({
        agentName: "explore",
        description: "Explore auth",
        parentSessionId: "parent",
        prompt: "Find auth code",
      }),
    ).resolves.toMatchObject({
      output: "exploration complete",
      sessionId: "child_1",
      success: true,
      summary: {
        duration: 100,
        steps: 0,
        toolCalls: [],
      },
    });
    expect(messages.createMessage).toHaveBeenCalledWith({
      agent: "explore",
      role: "user",
      sessionId: "child_1",
    });
    expect(messages.appendPart).toHaveBeenCalledWith("message_child", {
      text: "Find auth code",
      type: "text",
    });
    expect(runs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "explore",
        isSubagent: true,
        maxSteps: 15,
        parentMessageId: "message_child",
        sessionId: "child_1",
      }),
    );
    expect(tools.getAvailableTools).toHaveBeenCalledWith({
      agentName: "explore",
      isSubagent: true,
    });
  });

  it("returns an error result when a child run fails to start", async () => {
    const runs = createRunCoordinator();
    runs.create.mockImplementationOnce(() =>
      Promise.reject(new Error("child run rejected")),
    );
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: runs.coordinator,
      sessionManager: createSessionManager(),
      toolScheduler: createToolScheduler().scheduler,
    });

    await expect(
      service.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "run",
      }),
    ).resolves.toMatchObject({
      output: "child run rejected",
      success: false,
    });
  });

  it("rejects primary agents as subagents", async () => {
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: createRunCoordinator().coordinator,
      sessionManager: createSessionManager(),
      toolScheduler: createToolScheduler().scheduler,
    });

    await expect(
      service.execute({
        agentName: "build",
        parentSessionId: "parent",
        prompt: "do work",
      }),
    ).rejects.toThrow("Agent build cannot be used as a subagent");
  });

  it("enforces and releases the subagent concurrency limit", async () => {
    const blocker = deferred<{ readonly status: "succeeded" }>();
    const runs = createRunCoordinator();
    runs.coordinator.waitForCompletion = vi.fn(() => blocker.promise);
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      maxConcurrency: 1,
      messageManager: createMessageManager().manager,
      runCoordinator: runs.coordinator,
      sessionManager: createSessionManager(),
      toolScheduler: createToolScheduler().scheduler,
    });

    const first = service.execute({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await expect(
      service.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "second",
      }),
    ).rejects.toThrow("Maximum concurrent subagents reached");

    blocker.resolve({ status: "succeeded" });
    await expect(first).resolves.toMatchObject({ success: true });
  });

  it("uses a resumed child session instead of creating a new one", async () => {
    const sessionManager = createSessionManager();
    await sessionManager.create("D:/repo", {
      agentName: "explore",
      id: "child_existing",
      parentId: "parent",
      title: "Existing",
    });
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: createRunCoordinator().coordinator,
      sessionManager,
      toolScheduler: createToolScheduler().scheduler,
    });

    await expect(
      service.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "resume",
        resumeSessionId: "child_existing",
      }),
    ).resolves.toMatchObject({ sessionId: "child_existing", success: true });
    expect(sessionManager.create).toHaveBeenCalledTimes(1);
  });

  it("rejects resuming a missing child session without creating a new child", async () => {
    const sessionManager = createSessionManager();
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: createRunCoordinator().coordinator,
      sessionManager,
      toolScheduler: createToolScheduler().scheduler,
    });

    await expect(
      service.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "resume missing",
        resumeSessionId: "child_missing",
      }),
    ).rejects.toThrow("Subagent session not found: child_missing");
    expect(sessionManager.create).not.toHaveBeenCalled();
  });

  it("rejects resuming a child session owned by another parent", async () => {
    const sessionManager = createSessionManager();
    await sessionManager.create("D:/repo", {
      agentName: "explore",
      id: "child_other_parent",
      parentId: "other_parent",
      title: "Other parent",
    });
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: createRunCoordinator().coordinator,
      sessionManager,
      toolScheduler: createToolScheduler().scheduler,
    });

    await expect(
      service.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "resume wrong parent",
        resumeSessionId: "child_other_parent",
      }),
    ).rejects.toThrow(
      "Session child_other_parent is not a child of parent",
    );
    expect(sessionManager.create).toHaveBeenCalledTimes(1);
  });

  it("rejects resuming a child session owned by a different agent", async () => {
    const sessionManager = createSessionManager();
    await sessionManager.create("D:/repo", {
      agentName: "research",
      id: "child_research",
      parentId: "parent",
      title: "Research",
    });
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: createRunCoordinator().coordinator,
      sessionManager,
      toolScheduler: createToolScheduler().scheduler,
    });

    await expect(
      service.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "resume wrong agent",
        resumeSessionId: "child_research",
      }),
    ).rejects.toThrow(
      "Session child_research belongs to agent research, not explore",
    );
  });

  it("forces recursive tools off when an all-mode agent runs as a subagent", async () => {
    const tools = createToolScheduler();
    const service = new AgentService({
      agentManager: await createAgentManager(),
      buildPromptMessages: createPromptBuilder(),
      messageManager: createMessageManager().manager,
      runCoordinator: createRunCoordinator().coordinator,
      sessionManager: createSessionManager(),
      toolScheduler: tools.scheduler,
    });

    await service.execute({
      agentName: "universal",
      parentSessionId: "parent",
      prompt: "run as child",
    });

    expect(tools.getAvailableTools).toHaveBeenCalledWith({
      agentName: "universal",
      isSubagent: true,
    });
  });
});
