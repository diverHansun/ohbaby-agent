import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./service.js";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type { AgentsConfig } from "./types.js";
import type {
  AgentRunCoordinator,
  AgentRunEventSource,
} from "../core/agents/index.js";
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

async function createAgentManager(): Promise<AgentManager> {
  const registry = new AgentRegistry({
    configLoader: (): AgentsConfig => ({
      agents: {
        build: {
          description: "Primary builder",
          maxSteps: 1000,
          mode: "primary",
          name: "build",
          tools: { include: ["read", "subagent_run", "todo_read"] },
        },
        audit: {
          description: "Subagent explorer",
          mode: "subagent",
          name: "audit",
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
  const sessions = new Map<string, Session>();
  const create = vi.fn(
    (
      projectDirectory: string,
      options: {
        readonly agentName?: string;
        readonly id?: string;
        readonly parentId?: string;
        readonly title?: string;
      } = {},
    ): Promise<Session> => {
      const session: Session = {
        agentName: options.agentName ?? "default",
        childrenIds: [],
        createdAt: 1,
        id: options.id ?? "session_created",
        isSubagent: options.parentId !== undefined,
        parentId: options.parentId,
        projectId: "project",
        projectRoot: projectDirectory,
        stats: { messageCount: 0 },
        status: "active",
        title: options.title ?? "Session",
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

function createMessageManager(): {
  readonly appendPart: ReturnType<typeof vi.fn>;
  readonly createMessage: ReturnType<typeof vi.fn>;
  readonly manager: MessageManager;
} {
  const createMessage = vi.fn<MessageManager["createMessage"]>(
    (input): Promise<CoreMessage> =>
      Promise.resolve({
        agent: input.role === "system" ? undefined : input.agent,
        id: "message_user",
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
        sessionId: "primary_1",
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
      listBySession: vi.fn(
        (): Promise<MessageWithParts[]> => Promise.resolve([]),
      ),
      removeMessage: vi.fn((): Promise<void> => Promise.resolve()),
      removeMessages: vi.fn((): Promise<void> => Promise.resolve()),
      toModelMessages: vi.fn(() => Promise.resolve([])),
      updateMessage: vi.fn(
        (): Promise<CoreMessage> =>
          Promise.resolve({
            agent: "build",
            id: "message_user",
            role: "assistant",
            sessionId: "primary_1",
            time: { created: 1 },
          }),
      ),
      updatePart: vi.fn(
        (): Promise<Part> =>
          Promise.resolve({
            id: "part_user",
            messageId: "message_user",
            orderIndex: 0,
            sessionId: "primary_1",
            text: "updated",
            type: "text",
          }),
      ),
    },
  };
}

function createRunCoordinator(): {
  readonly coordinator: AgentRunCoordinator;
  readonly create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn<AgentRunCoordinator["create"]>((options) =>
    Promise.resolve({
      runId: "run_primary",
      sessionId: options.sessionId,
    }),
  );
  return {
    coordinator: {
      cancel: vi.fn<AgentRunCoordinator["cancel"]>(),
      create,
      waitForCompletion: vi.fn(() =>
        Promise.resolve({ status: "succeeded" as const }),
      ),
    },
    create,
  };
}

function createToolScheduler(): Pick<
  ToolSchedulerInstance,
  "getAvailableTools"
> {
  const readTool: ToolDefinition = {
    category: "readonly",
    description: "Read files",
    name: "read",
    parameters: { type: "object" },
    source: "builtin",
  };
  return {
    getAvailableTools: vi.fn(
      (): Promise<ToolDefinition[]> => Promise.resolve([readTool]),
    ),
  };
}

describe("AgentService", () => {
  it("starts a primary session through core runAgent stream mode", async () => {
    const messages = createMessageManager();
    const runs = createRunCoordinator();
    const sessionManager = createSessionManager();
    const event = {
      content: "hello",
      completeMessage: { content: "hello", role: "assistant" },
      delta: "hello",
      sessionId: "primary_1",
      timestamp: 1,
      type: "llm:delta",
    } as const;
    const subscribeRunEvents = vi.fn<AgentRunEventSource["subscribeRunEvents"]>(
      (): AsyncIterable<typeof event> =>
        (async function* (): AsyncIterable<typeof event> {
          await Promise.resolve();
          yield event;
        })(),
    );
    const service = new AgentService({
      agentManager: await createAgentManager(),
      messageManager: messages.manager,
      modelId: "fake-model",
      runCoordinator: runs.coordinator,
      runEventSource: { subscribeRunEvents },
      sessionManager,
      toolScheduler: createToolScheduler(),
    });

    const result = await service.startSession({
      agentName: "build",
      prompt: "Say hello",
      projectRoot: "D:/repo",
      sessionId: "primary_1",
      title: "Primary",
    });

    expect(result).toMatchObject({
      mode: "stream",
      runId: "run_primary",
      sessionId: "primary_1",
    });
    expect(sessionManager.create).toHaveBeenCalledWith("D:/repo", {
      agentName: "build",
      id: "primary_1",
      title: "Primary",
    });
    expect(messages.createMessage).toHaveBeenCalledWith({
      agent: "build",
      role: "user",
      sessionId: "primary_1",
    });
    expect(messages.appendPart).toHaveBeenCalledWith("message_user", {
      text: "Say hello",
      type: "text",
    });
    expect(runs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "build",
        directory: "D:/repo",
        isSubagent: false,
        maxSteps: 1000,
        modelId: "fake-model",
        parentMessageId: "message_user",
        sessionId: "primary_1",
      }),
    );
    expect(subscribeRunEvents).toHaveBeenCalledWith("run_primary");
  });

  it("rejects subagent-only agents as primary agents", async () => {
    const service = new AgentService({
      agentManager: await createAgentManager(),
      messageManager: createMessageManager().manager,
      modelId: "fake-model",
      runCoordinator: createRunCoordinator().coordinator,
      runEventSource: { subscribeRunEvents: vi.fn() },
      sessionManager: createSessionManager(),
      toolScheduler: createToolScheduler(),
    });

    await expect(
      service.startSession({
      agentName: "audit",
        prompt: "work",
        projectRoot: "D:/repo",
        sessionId: "primary_1",
      }),
    ).rejects.toThrow(/Agent audit.*cannot be used as a primary agent/);
  });
});
