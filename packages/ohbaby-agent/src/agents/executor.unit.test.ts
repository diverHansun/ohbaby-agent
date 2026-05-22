import { describe, expect, it, vi } from "vitest";
import { SubagentExecutor } from "./executor.js";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type {
  SubagentMessageWriter,
  SubagentRunner,
  SubagentSession,
  SubagentSessionManager,
  AgentsConfig,
} from "./types.js";

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
      const session: SubagentSession = {
        agentName: options?.agentName ?? "default",
        childrenIds: [],
        id: options?.id ?? `child_${String(nextChild++)}`,
        isSubagent: options?.parentId !== undefined,
        parentId: options?.parentId,
        projectRoot: "D:/repo",
      };
      sessions.set(session.id, session);
      return Promise.resolve(session);
    },
    get(sessionId): Promise<SubagentSession | null> {
      return Promise.resolve(sessions.get(sessionId) ?? null);
    },
  };
}

describe("SubagentExecutor", () => {
  it("creates an isolated child session, writes the prompt, and runs the subagent", async () => {
    const agentManager = await createAgentManager();
    const runnerRun = vi.fn<SubagentRunner["run"]>(() =>
      Promise.resolve({
        output: "exploration complete",
        steps: 2,
        success: true,
        toolCalls: [
          { id: "call_1", status: "completed" as const, tool: "read" },
        ],
      }),
    );
    const runner: SubagentRunner = {
      run: runnerRun,
    };
    const writeUserMessage = vi.fn<SubagentMessageWriter["writeUserMessage"]>(
      () => Promise.resolve({ messageId: "message_child" }),
    );
    const messageWriter: SubagentMessageWriter = {
      writeUserMessage,
    };
    const executor = new SubagentExecutor({
      agentManager,
      messageWriter,
      runner,
      sessionManager: createSessionManager(),
      now: (() => {
        let value = 1_000;
        return (): number => (value += 100);
      })(),
    });

    await expect(
      executor.execute({
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
        steps: 2,
        toolCalls: [{ id: "call_1", status: "completed", tool: "read" }],
      },
    });
    expect(writeUserMessage).toHaveBeenCalledWith({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "Find auth code",
      sessionId: "child_1",
    });
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "explore",
        parentMessageId: "message_child",
        parentSessionId: "parent",
        prompt: "Find auth code",
        projectRoot: "D:/repo",
        sessionId: "child_1",
      }),
    );
  });

  it("accepts a message writer that resolves without metadata", async () => {
    const messageWriter: SubagentMessageWriter = {
      writeUserMessage: () => Promise.resolve(),
    };
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      messageWriter,
      runner: {
        run: vi.fn<SubagentRunner["run"]>(() =>
          Promise.resolve({ output: "done", success: true }),
        ),
      },
      sessionManager: createSessionManager(),
    });

    await expect(
      executor.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "run",
      }),
    ).resolves.toMatchObject({ output: "done", success: true });
  });

  it("writes an assistant error turn when a child run fails to start", async () => {
    const writeAssistantMessage = vi.fn<
      NonNullable<SubagentMessageWriter["writeAssistantMessage"]>
    >(() => Promise.resolve());
    const messageWriter: SubagentMessageWriter = {
      writeAssistantMessage,
      writeUserMessage: () => Promise.resolve({ messageId: "message_child" }),
    };
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      messageWriter,
      runner: {
        run: vi.fn<SubagentRunner["run"]>(() =>
          Promise.reject(new Error("child run rejected")),
        ),
      },
      sessionManager: createSessionManager(),
    });

    await expect(
      executor.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "run",
      }),
    ).resolves.toMatchObject({
      output: "child run rejected",
      success: false,
    });
    expect(writeAssistantMessage).toHaveBeenCalledWith({
      agentName: "explore",
      output: "child run rejected",
      parentMessageId: "message_child",
      parentSessionId: "parent",
      sessionId: "child_1",
    });
  });

  it("rejects primary agents as subagents", async () => {
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      runner: { run: vi.fn() },
      sessionManager: createSessionManager(),
    });

    await expect(
      executor.execute({
        agentName: "build",
        parentSessionId: "parent",
        prompt: "do work",
      }),
    ).rejects.toThrow("Agent build cannot be used as a subagent");
  });

  it("enforces and releases the subagent concurrency limit", async () => {
    const blocker = deferred<{
      readonly output: string;
      readonly steps: number;
      readonly success: boolean;
    }>();
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      maxConcurrency: 1,
      runner: { run: vi.fn<SubagentRunner["run"]>(() => blocker.promise) },
      sessionManager: createSessionManager(),
    });

    const first = executor.execute({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "first",
    });
    await expect(
      executor.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "second",
      }),
    ).rejects.toThrow("Maximum concurrent subagents reached");

    blocker.resolve({ output: "done", steps: 1, success: true });
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(
      executor.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "third",
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it("uses a resumed child session instead of creating a new one", async () => {
    const sessionManager = createSessionManager();
    await sessionManager.create("D:/repo", {
      agentName: "explore",
      id: "child_existing",
      parentId: "parent",
      title: "Existing",
    });
    const create = vi.spyOn(sessionManager, "create");
    const runnerRun = vi.fn<SubagentRunner["run"]>(() =>
      Promise.resolve({
        output: "resumed",
        steps: 1,
        success: true,
      }),
    );
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      runner: {
        run: runnerRun,
      },
      sessionManager,
    });

    await expect(
      executor.execute({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "resume",
        resumeSessionId: "child_existing",
      }),
    ).resolves.toMatchObject({ sessionId: "child_existing", success: true });
    expect(create).not.toHaveBeenCalled();
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "D:/repo",
        sessionId: "child_existing",
      }),
    );
  });

  it("rejects resuming a child session owned by a different agent", async () => {
    const sessionManager = createSessionManager();
    await sessionManager.create("D:/repo", {
      agentName: "research",
      id: "child_research",
      parentId: "parent",
      title: "Research",
    });
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      runner: {
        run: vi.fn<SubagentRunner["run"]>(() =>
          Promise.resolve({
            output: "resumed",
            steps: 1,
            success: true,
          }),
        ),
      },
      sessionManager,
    });

    await expect(
      executor.execute({
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
    const runnerRun = vi.fn<SubagentRunner["run"]>(() =>
      Promise.resolve({ output: "done", steps: 1, success: true }),
    );
    const runner: SubagentRunner = {
      run: runnerRun,
    };
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      runner,
      sessionManager: createSessionManager(),
    });

    await executor.execute({
      agentName: "universal",
      parentSessionId: "parent",
      prompt: "run as child",
    });

    expect(runnerRun).toHaveBeenCalledOnce();
    const runInput = runnerRun.mock.calls[0][0];
    expect(runInput.runtimeAgent.isSubagent).toBe(true);
    expect(runInput.runtimeAgent.tools).toMatchObject({
      task: false,
      todo_read: true,
    });
  });
});
