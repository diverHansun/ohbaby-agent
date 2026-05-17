import { describe, expect, it, vi } from "vitest";
import { SubagentExecutor } from "./executor.js";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type {
  SubagentMessageWriter,
  SubagentRunner,
  SubagentSession,
  SubagentSessionManager,
} from "./types.js";

function deferred<T>() {
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
    configLoader: () => ({
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
      build: async ({ agent }) => `system:${agent.name}`,
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
    async create(_projectDirectory, options) {
      const session: SubagentSession = {
        agentName: options?.agentName ?? "default",
        childrenIds: [],
        id: options?.id ?? `child_${String(nextChild++)}`,
        isSubagent: options?.parentId !== undefined,
        parentId: options?.parentId,
        projectRoot: "D:/repo",
      };
      sessions.set(session.id, session);
      return session;
    },
    async get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
  };
}

describe("SubagentExecutor", () => {
  it("creates an isolated child session, writes the prompt, and runs the subagent", async () => {
    const agentManager = await createAgentManager();
    const runner: SubagentRunner = {
      run: vi.fn(async () => ({
        output: "exploration complete",
        steps: 2,
        success: true,
        toolCalls: [
          { id: "call_1", status: "completed" as const, tool: "read" },
        ],
      })),
    };
    const messageWriter: SubagentMessageWriter = {
      writeUserMessage: vi.fn(async () => ({ messageId: "message_child" })),
    };
    const executor = new SubagentExecutor({
      agentManager,
      messageWriter,
      runner,
      sessionManager: createSessionManager(),
      now: (() => {
        let value = 1_000;
        return () => (value += 100);
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
    expect(messageWriter.writeUserMessage).toHaveBeenCalledWith({
      agentName: "explore",
      parentSessionId: "parent",
      prompt: "Find auth code",
      sessionId: "child_1",
    });
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "Find auth code",
        sessionId: "child_1",
      }),
    );
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
      runner: { run: vi.fn(() => blocker.promise) },
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
    const executor = new SubagentExecutor({
      agentManager: await createAgentManager(),
      runner: {
        run: vi.fn(async () => ({
          output: "resumed",
          steps: 1,
          success: true,
        })),
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
        run: vi.fn(async () => ({
          output: "resumed",
          steps: 1,
          success: true,
        })),
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
    const runner: SubagentRunner = {
      run: vi.fn(async () => ({ output: "done", steps: 1, success: true })),
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

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAgent: expect.objectContaining({
          isSubagent: true,
          tools: expect.objectContaining({
            task: false,
            todo_read: false,
            todo_write: false,
          }),
        }),
      }),
    );
  });
});
