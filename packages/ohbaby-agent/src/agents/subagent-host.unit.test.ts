import { describe, expect, it, vi } from "vitest";
import type {
  AgentInstance,
  AgentInstanceFactory,
  AgentRunResult,
} from "../core/agents/index.js";
import type { Session } from "../services/session/index.js";
import type { RuntimeAgent } from "./types.js";
import { InMemorySubagentInstanceStore } from "./subagents/in-memory-store.js";
import { SessionSubagentHost } from "./subagent-host.js";

const parent: Session = {
  agentName: "build",
  childrenIds: [],
  createdAt: 1,
  id: "parent_1",
  isSubagent: false,
  projectId: "project_1",
  projectRoot: "/repo",
  stats: { messageCount: 0 },
  status: "active",
  title: "Parent",
  updatedAt: 1,
};

const child: Session = {
  ...parent,
  agentName: "subagent-container",
  id: "child_1",
  isSubagent: true,
  parentId: "parent_1",
  title: "Subagents",
};

function createHostFixture(): {
  readonly createInstance: ReturnType<
    typeof vi.fn<AgentInstanceFactory["create"]>
  >;
  readonly getRuntimeAgent: ReturnType<typeof vi.fn>;
  readonly host: SessionSubagentHost;
  readonly sessionCreate: ReturnType<typeof vi.fn>;
  readonly store: InMemorySubagentInstanceStore;
  readonly turn: ReturnType<typeof vi.fn<AgentInstance["turn"]>>;
} {
  const turn = vi.fn<AgentInstance["turn"]>(() =>
    Promise.resolve({
      finalOutput: "subagent output",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    } satisfies AgentRunResult),
  );
  const createInstance = vi.fn<AgentInstanceFactory["create"]>((identity) => ({
    contextScope: {} as AgentInstance["contextScope"],
    identity,
    turn,
  }));
  const sessions = new Map<string, Session>([["parent_1", parent]]);
  const sessionCreate = vi.fn((): Promise<Session> => {
    sessions.set("child_1", child);
    return Promise.resolve(child);
  });
  const sessionGet = vi.fn(
    (sessionId: string): Promise<Session | null> =>
      Promise.resolve(sessions.get(sessionId) ?? null),
  );
  const store = new InMemorySubagentInstanceStore();
  const getRuntimeAgent = vi.fn(
    (role: string): Promise<RuntimeAgent> =>
      Promise.resolve({
        config: {
          mode: "subagent" as const,
          name: role,
          maxSteps: 5,
        },
        isSubagent: true,
        systemPrompt: "system",
        tools: {},
      } satisfies RuntimeAgent),
  );
  const host = new SessionSubagentHost({
    agentManager: { getRuntimeAgent },
    createSubagentId: (() => {
      let next = 1;
      return (): string => `subagent_${String(next++)}`;
    })(),
    instanceFactory: { create: createInstance },
    modelId: "fake-model",
    now: (() => {
      let now = 1;
      return (): number => now++;
    })(),
    sessionManager: { create: sessionCreate, get: sessionGet },
    store,
  });
  return { createInstance, getRuntimeAgent, host, sessionCreate, store, turn };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SessionSubagentHost", () => {
  it("runs foreground subagents through scoped AgentInstance identity", async () => {
    const { createInstance, host, turn } = createHostFixture();

    const result = await host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "inspect",
      role: "explore",
    });

    expect(result.item).toMatchObject({
      contextScopeId: "subagent_1",
      sessionId: "child_1",
      status: "completed",
      subagentId: "subagent_1",
    });
    expect(result.item.subagentId).not.toBe(result.item.sessionId);
    expect(result.output).toBe("subagent output");
    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScopeId: "subagent_1",
        instanceId: "subagent_1",
        parentSessionId: "parent_1",
        sessionId: "child_1",
        type: "sub",
      }),
    );
    expect(turn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "inspect",
        waitMode: "waitForCompletion",
      }),
    );
  });

  it("treats closed subagents as terminal and rejects later turns", async () => {
    const { host, turn } = createHostFixture();

    const first = await host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "inspect",
      role: "explore",
    });
    const closed = await host.close({
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
    });

    expect(typeof closed.item.closedAt).toBe("number");
    expect(closed.item.status).toBe("cancelled");
    await expect(
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "try again",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("Subagent is closed");
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it("keeps a running subagent cancelled when close wins the race", async () => {
    const { host, turn } = createHostFixture();
    let resolveTurn!: () => void;
    turn.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          resolveTurn = (): void => {
            resolve({
              finalOutput: "late success",
              mode: "waitForCompletion",
              sessionId: "child_1",
              success: true,
            });
          };
        }),
    );

    const running = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "slow",
      role: "explore",
    });
    await flushMicrotasks();
    const status = await host.status({ parentSessionId: "parent_1" });
    const subagentId = status.items[0]?.subagentId;
    if (!subagentId) {
      throw new Error("Expected running subagent");
    }

    await host.close({ parentSessionId: "parent_1", subagentId });
    resolveTurn();
    const result = await running;

    expect(result.item).toMatchObject({
      status: "cancelled",
      subagentId,
    });
    expect(result.success).toBe(false);
    await expect(
      host.status({ parentSessionId: "parent_1", subagentId }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ status: "cancelled" })],
    });
  });

  it("keeps a scheduled background subagent cancelled when close happens before active registration", async () => {
    const { getRuntimeAgent, host, turn } = createHostFixture();
    let resolveRuntimeAgent!: () => void;
    getRuntimeAgent
      .mockResolvedValueOnce({
        config: {
          maxSteps: 5,
          mode: "subagent",
          name: "explore",
        },
        isSubagent: true,
        systemPrompt: "system",
        tools: {},
      } satisfies RuntimeAgent)
      .mockImplementationOnce(
        (role: string) =>
          new Promise<RuntimeAgent>((resolve) => {
            resolveRuntimeAgent = (): void => {
              resolve({
                config: {
                  maxSteps: 5,
                  mode: "subagent",
                  name: role,
                },
                isSubagent: true,
                systemPrompt: "system",
                tools: {},
              });
            };
          }),
      );
    turn.mockResolvedValueOnce({
      finalOutput: "late success",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    } satisfies AgentRunResult);

    const created = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "slow background",
      role: "explore",
    });
    await host.close({
      parentSessionId: "parent_1",
      subagentId: created.item.subagentId,
    });
    resolveRuntimeAgent();
    await flushMicrotasks();

    const status = await host.status({
      parentSessionId: "parent_1",
      subagentId: created.item.subagentId,
    });
    expect(status.items[0]).toMatchObject({
      status: "cancelled",
    });
    expect(typeof status.items[0]?.closedAt).toBe("number");
    expect(status.items[0]?.output).not.toBe("late success");
    expect(turn).not.toHaveBeenCalled();
  });

  it("marks a run timed_out when its deadline aborts the turn", async () => {
    vi.useFakeTimers();
    try {
      const { host, turn } = createHostFixture();
      turn.mockImplementationOnce(
        (input) =>
          new Promise<AgentRunResult>((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                resolve({
                  error: "aborted by deadline",
                  mode: "waitForCompletion",
                  sessionId: "child_1",
                  success: false,
                });
              },
              { once: true },
            );
            setTimeout(() => {
              resolve({
                finalOutput: "late success",
                mode: "waitForCompletion",
                sessionId: "child_1",
                success: true,
              });
            }, 50);
          }),
      );

      const running = host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "slow",
        role: "explore",
        timeoutMs: 5,
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await running;

      expect(result).toMatchObject({
        item: {
          error: "Subagent timed out after 5ms",
          output: "Subagent timed out after 5ms",
          status: "timed_out",
          timeoutMs: 5,
        },
        output: "Subagent timed out after 5ms",
        success: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat parent aborts as timeout even when reasons collide", async () => {
    const { host, turn } = createHostFixture();
    const controller = new AbortController();
    turn.mockImplementationOnce(
      (input) =>
        new Promise<AgentRunResult>((resolve) => {
          const resolveAbort = (): void => {
            resolve({
              error: String(input.signal?.reason ?? "aborted"),
              mode: "waitForCompletion",
              sessionId: "child_1",
              success: false,
            });
          };
          if (input.signal?.aborted) {
            resolveAbort();
            return;
          }
          input.signal?.addEventListener("abort", resolveAbort, { once: true });
        }),
    );

    const running = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "slow",
      role: "explore",
      signal: controller.signal,
      timeoutMs: 50,
    });
    controller.abort("Subagent timed out after 50ms");
    const result = await running;

    expect(result).toMatchObject({
      item: {
        output: "Subagent timed out after 50ms",
        status: "failed",
      },
      output: "Subagent timed out after 50ms",
      success: false,
    });
  });

  it("rejects invalid timeoutMs before creating a subagent record", async () => {
    const { host, sessionCreate, store, turn } = createHostFixture();

    await expect(
      host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "bad timeout",
        role: "explore",
        timeoutMs: 0,
      }),
    ).rejects.toThrow("subagent timeoutMs must be a positive number");

    await expect(store.listByParent("parent_1")).resolves.toEqual([]);
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(turn).not.toHaveBeenCalled();
  });

  it("lists status as items and marks restarted active subagents interrupted without auto-running", async () => {
    const { host, store, turn } = createHostFixture();
    await store.create({
      contextScopeId: "subagent_a",
      createdAt: 1,
      initialPrompt: "a",
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore",
      sessionId: "child_1",
      status: "running",
      subagentId: "subagent_a",
      updatedAt: 1,
    });
    await store.create({
      contextScopeId: "subagent_b",
      createdAt: 2,
      initialPrompt: "b",
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "research",
      sessionId: "child_1",
      status: "pending",
      subagentId: "subagent_b",
      updatedAt: 2,
    });

    const interrupted = await host.recoverInterrupted({
      parentSessionId: "parent_1",
      recoverUnknownOwner: true,
    });

    expect(interrupted.map((item) => item.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    const status = await host.status({ parentSessionId: "parent_1" });
    expect(status.items.map((item) => item.subagentId)).toEqual(
      expect.arrayContaining(["subagent_a", "subagent_b"]),
    );
    expect(turn).not.toHaveBeenCalled();
  });

  it("rejects foreground continuation while the same subagent is already running", async () => {
    const { host, turn } = createHostFixture();
    let complete!: () => void;
    turn.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          complete = (): void => {
            resolve({
              finalOutput: "eventual output",
              mode: "waitForCompletion",
              sessionId: "child_1",
              success: true,
            });
          };
        }),
    );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();

    await expect(
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "second",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("Subagent is already running");
    expect(turn).toHaveBeenCalledTimes(1);

    complete();
    await flushMicrotasks();
  });

  it("drains all queued background turns in order", async () => {
    const { host, turn } = createHostFixture();
    const completions: (() => void)[] = [];
    turn.mockImplementation((input) => {
      return new Promise<AgentRunResult>((resolve) => {
        completions.push(() => {
          resolve({
            finalOutput: `done ${input.prompt}`,
            mode: "waitForCompletion",
            sessionId: "child_1",
            success: true,
          });
        });
      });
    });

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });
    await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "third",
      subagentId: first.item.subagentId,
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
    completions.shift()?.();
    await flushMicrotasks();
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "second",
    ]);
    completions.shift()?.();
    await flushMicrotasks();
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "second",
      "third",
    ]);
    completions.shift()?.();
    await flushMicrotasks();

    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          output: "done third",
          pendingQueue: [],
          status: "completed",
        }),
      ],
    });
  });

  it("serializes new subagent creation so concurrent instances share one child session", async () => {
    const { host, sessionCreate, store, turn } = createHostFixture();
    turn.mockImplementation(() =>
      Promise.resolve({
        finalOutput: "done",
        mode: "waitForCompletion",
        sessionId: "child_1",
        success: true,
      } satisfies AgentRunResult),
    );

    const [first, second] = await Promise.all([
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "first",
        role: "explore",
      }),
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "second",
        role: "research",
      }),
    ]);

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(first.item.sessionId).toBe("child_1");
    expect(second.item.sessionId).toBe("child_1");
    expect(first.item.subagentId).not.toBe(second.item.subagentId);
    const status = await host.status({ parentSessionId: "parent_1" });
    expect(status.items.map((item) => item.subagentId)).toEqual(
      expect.arrayContaining([first.item.subagentId, second.item.subagentId]),
    );
    await expect(store.listByParent("parent_1")).resolves.toHaveLength(2);
  });
});
