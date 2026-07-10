import { describe, expect, it, vi } from "vitest";
import type {
  AgentInstance,
  AgentInstanceFactory,
  AgentRunResult,
} from "../core/agents/index.js";
import type { ToolExecutionEnvironment } from "../core/tool-scheduler/index.js";
import type { Session } from "../services/session/index.js";
import type { RuntimeAgent } from "./types.js";
import { InMemorySubagentInstanceStore } from "./subagents/in-memory-store.js";
import type {
  SubagentInstanceRecord,
  SubagentInstanceUpdate,
} from "./subagents/types.js";
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

function createHostFixture(
  options: {
    readonly existingChild?: Session;
    readonly store?: InMemorySubagentInstanceStore;
  } = {},
): {
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
  if (options.existingChild) {
    sessions.set(options.existingChild.id, options.existingChild);
  }
  const sessionCreate = vi.fn((): Promise<Session> => {
    sessions.set("child_1", child);
    return Promise.resolve(child);
  });
  const sessionGet = vi.fn(
    (sessionId: string): Promise<Session | null> =>
      Promise.resolve(sessions.get(sessionId) ?? null),
  );
  const store = options.store ?? new InMemorySubagentInstanceStore();
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
    createRunId: (() => {
      let next = 1;
      return (): string => `run_${String(next++)}`;
    })(),
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
    ownerId: "owner_current",
    ownerPid: 101,
    sessionManager: { create: sessionCreate, get: sessionGet },
    store,
  });
  return { createInstance, getRuntimeAgent, host, sessionCreate, store, turn };
}

class ClaimFailingStore extends InMemorySubagentInstanceStore {
  override claim(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): ReturnType<InMemorySubagentInstanceStore["claim"]> {
    void subagentId;
    void update;
    return Promise.reject(new Error("claim persistence failed"));
  }
}

class QueueAppendFailingStore extends InMemorySubagentInstanceStore {
  override appendPendingQueue(
    subagentId: string,
    input: Parameters<InMemorySubagentInstanceStore["appendPendingQueue"]>[1],
    updatedAt: number,
  ): ReturnType<InMemorySubagentInstanceStore["appendPendingQueue"]> {
    void subagentId;
    void input;
    void updatedAt;
    return Promise.reject(new Error("queue persistence failed"));
  }
}

class ClaimHookStore extends InMemorySubagentInstanceStore {
  onClaim?: () => void;

  override async claim(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord | null> {
    const claimed = await super.claim(subagentId, update);
    this.onClaim?.();
    return claimed;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SessionSubagentHost", () => {
  it("rejects the foreground caller when durable claim persistence fails", async () => {
    const { host, turn } = createHostFixture({
      store: new ClaimFailingStore(),
    });

    await expect(
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "inspect",
        role: "explore",
      }),
    ).rejects.toThrow("claim persistence failed");
    expect(turn).not.toHaveBeenCalled();
  });

  it("rejects the background caller when the initial durable claim fails", async () => {
    const { host, turn } = createHostFixture({
      store: new ClaimFailingStore(),
    });

    await expect(
      host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "inspect",
        role: "explore",
      }),
    ).rejects.toThrow("claim persistence failed");
    expect(turn).not.toHaveBeenCalled();
  });

  it("does not retain an in-memory queue entry when durable append fails", async () => {
    const { host, store, turn } = createHostFixture({
      store: new QueueAppendFailingStore(),
    });
    let completeFirst!: () => void;
    turn.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          completeFirst = (): void => {
            resolve({
              finalOutput: "first completed",
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
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "must not become a ghost task",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("queue persistence failed");

    completeFirst();
    await vi.waitUntil(async () => {
      const item = await store.get({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return item?.status === "completed";
    });
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ pendingQueue: [], status: "completed" }),
      ],
    });
  });

  it("settles an interrupt delivered after a durable claim before starting its turn", async () => {
    const store = new ClaimHookStore();
    const { host, turn } = createHostFixture({ store });
    let interrupted: Promise<readonly SubagentInstanceRecord[]> | undefined;
    store.onClaim = (): void => {
      interrupted = host.interruptByParent(
        "parent_1",
        "parent interrupted after claim",
      );
    };

    const result = await host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "must not start",
      role: "explore",
    });
    if (!interrupted) {
      throw new Error("Expected the claim hook to interrupt the subagent");
    }
    await interrupted;

    expect(turn).not.toHaveBeenCalled();
    expect(result.item).toMatchObject({
      currentInput: undefined,
      currentRunId: undefined,
      lastRunId: "run_1",
      status: "interrupted",
    });

    store.onClaim = undefined;
    await expect(
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "resume after interruption",
        subagentId: result.item.subagentId,
      }),
    ).resolves.toMatchObject({
      item: {
        currentInput: undefined,
        currentRunId: undefined,
        lastRunId: "run_2",
        status: "completed",
      },
      success: true,
    });
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "resume after interruption",
    ]);
  });

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

  it("rejects a durable child session that belongs to another parent", async () => {
    const store = new InMemorySubagentInstanceStore();
    await store.create({
      contextScopeId: "subagent_1",
      createdAt: 1,
      initialPrompt: "inspect",
      ownerId: "owner_current",
      ownerPid: 101,
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore",
      sessionId: "child_1",
      status: "completed",
      subagentId: "subagent_1",
      updatedAt: 1,
    });
    const { host, turn } = createHostFixture({
      existingChild: { ...child, parentId: "parent_other" },
      store,
    });

    await expect(
      host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "continue",
        subagentId: "subagent_1",
      }),
    ).rejects.toThrow("does not belong to parent_1");
    expect(turn).not.toHaveBeenCalled();
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
      currentInput: undefined,
      currentRunId: undefined,
      lastRunId: "run_1",
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

  it("records currentRunId while running and lastRunId after completion", async () => {
    const { host, turn } = createHostFixture();
    let resolveTurn!: () => void;
    turn.mockImplementationOnce(
      (input) =>
        new Promise<AgentRunResult>((resolve) => {
          resolveTurn = (): void => {
            resolve({
              finalOutput: `done ${input.prompt}`,
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
    await vi.waitUntil(async () => {
      const status = await host.status({ parentSessionId: "parent_1" });
      return status.items[0]?.status === "running";
    });

    await expect(
      host.status({ parentSessionId: "parent_1" }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          currentInput: { prompt: "slow" },
          currentRunId: "run_1",
          status: "running",
        }),
      ],
    });

    resolveTurn();
    await expect(running).resolves.toMatchObject({
      item: {
        currentInput: undefined,
        currentRunId: undefined,
        lastRunId: "run_1",
        output: "done slow",
        status: "completed",
      },
    });
    expect(turn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "slow", runId: "run_1" }),
    );
  });

  it("keeps per-turn timeout overrides out of the instance default and reclaims owner", async () => {
    const { host, store, turn } = createHostFixture();
    const first = await host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await store.update(first.item.subagentId, {
      ownerId: "owner_old",
      ownerPid: 202,
      updatedAt: 10,
    });
    let complete!: () => void;
    turn.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          complete = (): void => {
            resolve({
              finalOutput: "second done",
              mode: "waitForCompletion",
              sessionId: "child_1",
              success: true,
            });
          };
        }),
    );

    const second = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
      timeoutMs: 5_000,
    });
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "running";
    });
    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          currentInput: { prompt: "second", timeoutMs: 5_000 },
          ownerId: "owner_current",
          ownerPid: 101,
          timeoutMs: 2 * 60 * 60 * 1_000,
        }),
      ],
    });

    complete();
    await expect(second).resolves.toMatchObject({
      item: { status: "completed", timeoutMs: 2 * 60 * 60 * 1_000 },
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

  it("enforces the host deadline when the agent turn ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const { host, turn } = createHostFixture();
      turn.mockImplementationOnce(
        () =>
          new Promise<AgentRunResult>(() => {
            void 0;
          }),
      );

      const running = host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "ignore abort",
        role: "explore",
        timeoutMs: 5,
      });
      await vi.advanceTimersByTimeAsync(5);

      await expect(running).resolves.toMatchObject({
        item: {
          currentInput: undefined,
          currentRunId: undefined,
          status: "timed_out",
        },
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
        status: "interrupted",
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

    await expect(
      host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "too long",
        role: "explore",
        timeoutMs: 7_200_001,
      }),
    ).rejects.toThrow("must not exceed 7200000ms");
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

  it("disposes active work as interrupted without draining queued prompts", async () => {
    const { host, turn } = createHostFixture();
    turn.mockImplementation(
      () =>
        new Promise<AgentRunResult>(() => {
          // Deliberately ignores abort to verify host disposal does not wait for it.
        }),
    );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "running";
    });
    await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });

    await host.dispose();

    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          pendingQueue: [{ prompt: "second" }],
          status: "interrupted",
        }),
      ],
    });
    expect(turn).toHaveBeenCalledTimes(1);
    await expect(
      host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "third",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("Subagent host is disposed");
  });

  it("marks a record interrupted when disposal wins during creation admission", async () => {
    const { getRuntimeAgent, host, store } = createHostFixture();
    let releaseAgent!: (agent: RuntimeAgent) => void;
    getRuntimeAgent.mockImplementationOnce(
      () =>
        new Promise<RuntimeAgent>((resolve) => {
          releaseAgent = resolve;
        }),
    );
    const running = host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "created during dispose",
      role: "explore",
    });
    await flushMicrotasks();

    await host.dispose();
    releaseAgent({
      config: { maxSteps: 5, mode: "subagent", name: "explore" },
      isSubagent: true,
      systemPrompt: "system",
      tools: {},
    });

    await expect(running).rejects.toThrow("Subagent host is disposed");
    await expect(store.listByParent("parent_1")).resolves.toMatchObject([
      {
        pendingQueue: [{ prompt: "created during dispose" }],
        status: "interrupted",
      },
    ]);
  });

  it("rejects cross-host input while another runtime owns the active run", async () => {
    const store = new InMemorySubagentInstanceStore();
    const firstFixture = createHostFixture({ store });
    firstFixture.turn.mockImplementation(
      () =>
        new Promise<AgentRunResult>(() => {
          // The first runtime keeps ownership for this assertion.
        }),
    );
    const first = await firstFixture.host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    const secondFixture = createHostFixture({ existingChild: child, store });

    await expect(
      secondFixture.host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "must retry later",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("active under another runtime owner");
    await expect(
      store.get({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({ pendingQueue: [], status: "running" });

    await firstFixture.host.dispose();
  });

  it("queues a foreground continuation behind the running turn", async () => {
    const { host, turn } = createHostFixture();
    let completeFirst!: () => void;
    turn
      .mockImplementationOnce(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            completeFirst = (): void => {
              resolve({
                finalOutput: "first output",
                mode: "waitForCompletion",
                sessionId: "child_1",
                success: true,
              });
            };
          }),
      )
      .mockImplementationOnce((input) =>
        Promise.resolve({
          finalOutput: `done ${input.prompt}`,
          mode: "waitForCompletion",
          sessionId: "child_1",
          success: true,
        } satisfies AgentRunResult),
      );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();

    const second = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });
    await flushMicrotasks();
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);

    completeFirst();
    await expect(second).resolves.toMatchObject({
      item: {
        output: "done second",
        pendingQueue: [],
        status: "completed",
      },
      output: "done second",
      success: true,
    });
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "second",
    ]);
  });

  it("detaches an aborted foreground waiter without deleting its durable prompt", async () => {
    const { host, turn } = createHostFixture();
    let completeFirst!: () => void;
    turn.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          completeFirst = (): void => {
            resolve({
              finalOutput: "first output",
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
    const controller = new AbortController();
    const queued = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "cancel me",
      signal: controller.signal,
      subagentId: first.item.subagentId,
    });
    await flushMicrotasks();

    controller.abort("caller cancelled");
    await expect(queued).rejects.toThrow("caller cancelled");
    completeFirst();
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "completed";
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "cancel me",
    ]);
    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ pendingQueue: [] })],
    });
  });

  it("interrupts every active subagent under a parent without draining queued prompts", async () => {
    const { host, turn } = createHostFixture();
    turn.mockImplementation(
      (input) =>
        new Promise<AgentRunResult>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                error: "parent stopped",
                mode: "waitForCompletion",
                sessionId: "child_1",
                success: false,
              });
            },
            { once: true },
          );
        }),
    );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first active",
      role: "explore",
    });
    const second = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second active",
      role: "research",
    });
    await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first queued",
      subagentId: first.item.subagentId,
    });

    const interrupted = await host.interruptByParent(
      "parent_1",
      "parent stopped",
    );

    expect(interrupted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pendingQueue: [{ prompt: "first queued" }],
          status: "interrupted",
          subagentId: first.item.subagentId,
        }),
        expect.objectContaining({
          pendingQueue: [],
          status: "interrupted",
          subagentId: second.item.subagentId,
        }),
      ]),
    );
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first active",
      "second active",
    ]);
    await flushMicrotasks();
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first active",
      "second active",
    ]);
  });

  it("resolves a queued foreground continuation when close cancels it", async () => {
    const { host, turn } = createHostFixture();
    turn.mockImplementationOnce(
      (input) =>
        new Promise<AgentRunResult>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                error: "closed",
                mode: "waitForCompletion",
                sessionId: "child_1",
                success: false,
              });
            },
            { once: true },
          );
        }),
    );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();

    const queued = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });
    await flushMicrotasks();
    expect(turn).toHaveBeenCalledTimes(1);

    await host.close({
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
    });
    await expect(queued).resolves.toMatchObject({
      item: { pendingQueue: [], status: "cancelled" },
      success: false,
    });
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

  it("pauses queued turns after failure until an explicit resume appends a new prompt at the tail", async () => {
    const { host, turn } = createHostFixture();
    let failFirst!: () => void;
    turn.mockImplementation((input) => {
      if (input.prompt === "first") {
        return new Promise<AgentRunResult>((resolve) => {
          failFirst = (): void => {
            resolve({
              error: "first failed",
              mode: "waitForCompletion",
              sessionId: "child_1",
              success: false,
            });
          };
        });
      }
      return Promise.resolve({
        finalOutput: `done ${input.prompt}`,
        mode: "waitForCompletion",
        sessionId: "child_1",
        success: true,
      } satisfies AgentRunResult);
    });

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await host.run({
      environment: { workdir: "/queued-workdir" } as ToolExecutionEnvironment,
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

    failFirst();
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "failed";
    });
    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          pendingQueue: [
            { prompt: "second", workdir: "/queued-workdir" },
            { prompt: "third" },
          ],
          status: "failed",
        }),
      ],
    });

    const resumed = await host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "resume",
      subagentId: first.item.subagentId,
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "second",
      "third",
      "resume",
    ]);
    expect(turn.mock.calls[1]?.[0].workdir).toBe("/queued-workdir");
    expect(resumed).toMatchObject({
      item: {
        output: "done resume",
        pendingQueue: [],
        status: "completed",
      },
      output: "done resume",
      success: true,
    });
  });

  it("retains a foreground prompt after settling its waiter from an earlier failure", async () => {
    const { host, turn } = createHostFixture();
    let failFirst!: () => void;
    turn.mockImplementation((input) => {
      if (input.prompt === "first") {
        return new Promise<AgentRunResult>((resolve) => {
          failFirst = (): void => {
            resolve({
              error: "first failed",
              mode: "waitForCompletion",
              sessionId: "child_1",
              success: false,
            });
          };
        });
      }
      return Promise.resolve({
        finalOutput: `done ${input.prompt}`,
        mode: "waitForCompletion",
        sessionId: "child_1",
        success: true,
      } satisfies AgentRunResult);
    });
    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    const queued = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "foreground queued",
      subagentId: first.item.subagentId,
    });
    await flushMicrotasks();

    failFirst();
    await expect(queued).resolves.toMatchObject({
      item: {
        pendingQueue: [{ prompt: "foreground queued" }],
        status: "failed",
      },
      success: false,
    });
    await host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "explicit resume",
      subagentId: first.item.subagentId,
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "foreground queued",
      "explicit resume",
    ]);
  });

  it("keeps queued turns paused after timeout until an explicit resume", async () => {
    vi.useFakeTimers();
    try {
      const { host, turn } = createHostFixture();
      turn.mockImplementation((input) => {
        if (input.prompt === "first") {
          return new Promise<AgentRunResult>((resolve) => {
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
          });
        }
        return Promise.resolve({
          finalOutput: `done ${input.prompt}`,
          mode: "waitForCompletion",
          sessionId: "child_1",
          success: true,
        } satisfies AgentRunResult);
      });

      const first = await host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "first",
        role: "explore",
        timeoutMs: 5,
      });
      await vi.advanceTimersByTimeAsync(0);
      await host.run({
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "second",
        subagentId: first.item.subagentId,
      });

      await vi.advanceTimersByTimeAsync(5);
      await vi.waitUntil(async () => {
        const status = await host.status({
          parentSessionId: "parent_1",
          subagentId: first.item.subagentId,
        });
        return status.items[0]?.status === "timed_out";
      });
      expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
      await expect(
        host.status({
          parentSessionId: "parent_1",
          subagentId: first.item.subagentId,
        }),
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            pendingQueue: [{ prompt: "second" }],
            status: "timed_out",
          }),
        ],
      });

      const resumed = await host.run({
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "resume",
        subagentId: first.item.subagentId,
      });

      expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
        "first",
        "second",
        "resume",
      ]);
      expect(resumed.item).toMatchObject({
        output: "done resume",
        pendingQueue: [],
        status: "completed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves queued turns when interrupting a running subagent replacement", async () => {
    const { host, turn } = createHostFixture();
    turn.mockImplementation((input) => {
      if (input.prompt === "first") {
        return new Promise<AgentRunResult>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                error: "interrupted",
                mode: "waitForCompletion",
                sessionId: "child_1",
                success: false,
              });
            },
            { once: true },
          );
        });
      }
      return Promise.resolve({
        finalOutput: `done ${input.prompt}`,
        mode: "waitForCompletion",
        sessionId: "child_1",
        success: true,
      } satisfies AgentRunResult);
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
      interrupt: true,
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "third",
      subagentId: first.item.subagentId,
    });

    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.output === "done third";
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "second",
      "third",
    ]);
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

  it("pauses an interrupt replacement until a non-cooperative turn settles", async () => {
    const { host, turn } = createHostFixture();
    let settleFirst!: (result: AgentRunResult) => void;
    turn.mockImplementation((input) => {
      if (input.prompt === "first") {
        return new Promise<AgentRunResult>((resolve) => {
          settleFirst = resolve;
        });
      }
      return Promise.resolve({
        finalOutput: `done ${input.prompt}`,
        mode: "waitForCompletion",
        sessionId: "child_1",
        success: true,
      } satisfies AgentRunResult);
    });

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await host.run({
      interrupt: true,
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "replacement",
      subagentId: first.item.subagentId,
    });

    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "interrupted";
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
    await expect(
      host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          pendingQueue: [{ prompt: "replacement" }],
          status: "interrupted",
        }),
      ],
    });

    settleFirst({
      finalOutput: "late first",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    });
    await flushMicrotasks();
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
  });

  it("queues an explicit resume until its interrupted turn settles", async () => {
    const { host, turn } = createHostFixture();
    let settleFirst!: (result: AgentRunResult) => void;
    turn.mockImplementation((input) => {
      if (input.prompt === "first") {
        return new Promise<AgentRunResult>((resolve) => {
          settleFirst = resolve;
        });
      }
      return Promise.resolve({
        finalOutput: `done ${input.prompt}`,
        mode: "waitForCompletion",
        sessionId: "child_1",
        success: true,
      } satisfies AgentRunResult);
    });

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await host.run({
      interrupt: true,
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "replacement",
      subagentId: first.item.subagentId,
    });
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "interrupted";
    });

    const resumed = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "resume",
      subagentId: first.item.subagentId,
    });

    expect(resumed.item).toMatchObject({
      pendingQueue: [{ prompt: "replacement" }, { prompt: "resume" }],
      status: "interrupted",
    });
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);

    settleFirst({
      finalOutput: "late first",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    });
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.output === "done resume";
    });

    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "first",
      "replacement",
      "resume",
    ]);
  });

  it("interrupts a resume waiting for an earlier non-cooperative turn", async () => {
    const { host, turn } = createHostFixture();
    turn.mockImplementation(
      () =>
        new Promise<AgentRunResult>(() => {
          void 0;
        }),
    );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await host.run({
      interrupt: true,
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "replacement",
      subagentId: first.item.subagentId,
    });
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "interrupted";
    });
    await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "resume",
      subagentId: first.item.subagentId,
    });

    await expect(
      host.interruptByParent("parent_1", "parent stopped"),
    ).resolves.toEqual([
      expect.objectContaining({
        pendingQueue: [{ prompt: "replacement" }, { prompt: "resume" }],
        status: "interrupted",
        subagentId: first.item.subagentId,
      }),
    ]);
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
  });

  it("returns cancelled when close wins over a foreground resume settlement barrier", async () => {
    const { host, turn } = createHostFixture();
    turn.mockImplementation(
      () =>
        new Promise<AgentRunResult>(() => {
          void 0;
        }),
    );

    const first = await host.run({
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await host.run({
      interrupt: true,
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "replacement",
      subagentId: first.item.subagentId,
    });
    await vi.waitUntil(async () => {
      const status = await host.status({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "interrupted";
    });

    const resumed = host.run({
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "resume",
      subagentId: first.item.subagentId,
    });
    await flushMicrotasks();
    await host.close({
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
    });

    await expect(resumed).resolves.toMatchObject({
      item: { pendingQueue: [], status: "cancelled" },
      success: false,
    });
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual(["first"]);
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
