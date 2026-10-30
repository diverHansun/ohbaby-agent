import { TestSessionSubagentHost as SessionSubagentHost } from "../core/testing/runtime-model-fixtures.js";
import { mergeReasoningIntent, type ReasoningIntent } from "ohbaby-llm";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentInstance,
  AgentInstanceFactory,
  AgentRunResult,
} from "../core/agents/index.js";
import type { Session } from "../services/session/index.js";
import type { RuntimeAgent } from "./types.js";
import { InMemorySubagentInstanceStore } from "./subagents/in-memory-store.js";
import type {
  SubagentInstanceRecord,
  SubagentInstanceUpdate,
  SubagentRunInput,
  SubagentRunResult,
} from "./subagents/types.js";
import { InMemorySubagentExecutionStore } from "./subagents/execution-store.js";

import { createSubagentTools } from "../tools/subagent.js";
import { formatToolResultContentForModel } from "../core/context/tool-metadata-projection.js";

const parent: Session = {
  agentName: "build",
  childrenIds: [],
  createdAt: 1,
  id: "parent_1",
  isSubagent: false,
  projectId: "project_1",
  workingDirectory: "/repo",
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
    readonly getParentReasoning?: (
      sessionId: string,
      contextScopeId?: string,
    ) => ReasoningIntent | undefined;
    readonly existingChild?: Session;
    readonly executionStore?: InMemorySubagentExecutionStore;
    readonly onFatal?: (error: Error, rootRunId: string) => void;
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
    turn: async (input): Promise<AgentRunResult> => {
      await input.onInputReady?.();
      return turn(input);
    },
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
        tools: {},
      } satisfies RuntimeAgent),
  );
  const host = new SessionSubagentHost({
    executionStore:
      options.executionStore ?? new InMemorySubagentExecutionStore(),
    onFatal: options.onFatal,
    resolveRequester: (
      input,
    ): Promise<{ rootRunId: string; rootSessionId: string }> =>
      Promise.resolve({
        rootRunId: input.requesterRunId,
        rootSessionId: input.parentSessionId,
      }),
    getParentReasoning: options.getParentReasoning,
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

let invocationSequence = 0;
/** Old worker-behavior cases observe instance binding explicitly; acceptance itself is tested separately. */
async function runAndObserve(
  host: SessionSubagentHost,
  input: Omit<
    SubagentRunInput,
    "requesterRunId" | "requesterMessageId" | "requestId"
  >,
): Promise<SubagentRunResult & { item: SubagentInstanceRecord }> {
  const result = await host.run({
    ...input,
    requesterRunId: "parent_run",
    requesterMessageId: "parent_message",
    requestId: `call_${String(++invocationSequence)}`,
  });
  if (result.item) return { ...result, item: result.item };
  for (let i = 0; i < 100; i++) {
    const status = await host.list({
      parentSessionId: input.parentSessionId,
      subagentId: result.execution.subagentId,
    });
    const item = status.items.at(0);
    const failed = status.executions.find(
      (entry) =>
        entry.executionId === result.execution.executionId &&
        entry.status === "failed",
    );
    if (
      failed &&
      !item?.currentInput?.executionId?.includes(result.execution.executionId)
    )
      throw new Error(failed.error);
    if (
      item &&
      (item.currentInput?.executionId === result.execution.executionId ||
        item.pendingQueue.some(
          (queued) => queued.executionId === result.execution.executionId,
        ) ||
        status.executions.some(
          (entry) =>
            entry.executionId === result.execution.executionId &&
            !["queued", "running"].includes(entry.status),
        )) &&
      item.status !== "pending"
    )
      return { ...result, item };
    const execution = status.executions.find(
      (entry) => entry.executionId === result.execution.executionId,
    );
    if (execution?.status === "failed") throw new Error(execution.error);
    await Promise.resolve();
  }
  const item = (
    await host.list({
      parentSessionId: input.parentSessionId,
      subagentId: result.execution.subagentId,
    })
  ).items.at(0);
  if (!item) throw new Error("Instance did not bind");
  return { ...result, item };
}

describe("SessionSubagentHost", () => {
  it.each([
    ["model", "provider/legacy"],
    ["maxTokens", 100],
    ["temperature", 0.5],
    ["topP", 0.9],
    ["model", undefined],
    ["maxTokens", undefined],
    ["temperature", undefined],
    ["topP", undefined],
  ] as const)(
    "rejects custom child runtime config %s before a model run (value %s)",
    async (field, value) => {
      for (const lookup of ["admission", "turn"] as const) {
        const { host, getRuntimeAgent, turn } = createHostFixture();
        if (lookup === "turn")
          getRuntimeAgent.mockResolvedValueOnce({
            config: { name: "explore", mode: "subagent" },
            isSubagent: true,
            tools: {},
          });
        getRuntimeAgent.mockResolvedValue({
          config: { name: "explore", mode: "subagent", [field]: value },
          isSubagent: true,
          tools: {},
        });
        const run = runAndObserve(host, {
          mode: "foreground",
          parentSessionId: "parent_1",
          role: "explore",
          prompt: "inspect",
        });
        if (lookup === "admission") {
          await expect(run).rejects.toThrow(new RegExp(`explore.*${field}`));
        } else {
          const result = await run;
          expect(result.success).toBe(false);
          expect(result.execution.status).toBe("failed");
          expect(result.execution.error).toMatch(
            new RegExp(`explore.*${field}`),
          );
        }
        expect(turn).not.toHaveBeenCalled();
        await host.dispose();
      }
    },
  );

  it.each(["accept", "bindChild", "start"] as const)(
    "seals and reports fatal %s persistence failures",
    async (method) => {
      const executionStore = new InMemorySubagentExecutionStore();
      const onFatal = vi.fn();
      vi.spyOn(executionStore, method).mockRejectedValue(
        new Error("database unavailable"),
      );
      const { host } = createHostFixture({ executionStore, onFatal });
      await expect(
        host.run({
          requesterRunId: "root",
          requesterMessageId: "message",
          requestId: "call",
          parentSessionId: "parent_1",
          prompt: "task",
          role: "explore",
          mode: "foreground",
        }),
      ).rejects.toThrow("database unavailable");
      expect(onFatal).toHaveBeenCalledWith(expect.any(Error), "root");
      await expect(
        host.run({
          requesterRunId: "root",
          requesterMessageId: "message",
          requestId: "later",
          parentSessionId: "parent_1",
          prompt: "task",
          role: "explore",
          mode: "foreground",
        }),
      ).rejects.toThrow(/database unavailable|closed/);
    },
  );
  it("rejects send to a closed instance even when its old tool request is retried", async () => {
    const { host, turn } = createHostFixture();
    const base = {
      requesterRunId: "root",
      requesterMessageId: "message",
      parentSessionId: "parent_1",
      mode: "foreground" as const,
    };
    const first = await host.run({
      ...base,
      requestId: "first",
      prompt: "first",
      role: "explore",
    });
    const input = {
      ...base,
      requestId: "follow",
      prompt: "follow",
      subagentId: first.execution.subagentId,
    };
    const follow = await host.run(input);
    await host.close({
      parentSessionId: "parent_1",
      subagentId: follow.execution.subagentId,
    });
    await expect(host.run(input)).rejects.toThrow(/closed/);
    expect(turn).toHaveBeenCalledTimes(2);
  });
  it("does not start a child turn when Stop wins during the execution identity read", async () => {
    const executionStore = new InMemorySubagentExecutionStore();
    const originalGet = executionStore.get.bind(executionStore);
    let releaseRead!: () => void;
    let enterRead!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    vi.spyOn(executionStore, "get").mockImplementation(async (lookup) => {
      const record = await originalGet(lookup);
      if (record?.status === "running") {
        enterRead();
        await readGate;
      }
      return record;
    });
    const { host, turn } = createHostFixture({ executionStore });
    const accepted = await host.run({
      requesterRunId: "root",
      requesterMessageId: "message",
      requestId: "first",
      parentSessionId: "parent_1",
      prompt: "must not start",
      role: "explore",
      mode: "background",
    });
    await enteredRead;
    await host.interruptByRootRun("root", "stopped");
    releaseRead();
    await vi.waitFor(async () => {
      expect(
        (
          await executionStore.get({
            executionId: accepted.execution.executionId,
            parentSessionId: "parent_1",
          })
        )?.status,
      ).toBe("interrupted");
    });
    expect(turn).not.toHaveBeenCalled();
  });
  it("does not present the old failure as the reason for closing an idle instance", async () => {
    const { host, turn } = createHostFixture();
    turn.mockResolvedValueOnce({
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: false,
      error: "old failure",
    });
    const first = await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    const tool = createSubagentTools(host).find(
      (candidate) => candidate.name === "agent",
    );
    if (!tool) throw new Error("Missing subagent_close tool");
    const result = await tool.execute(
      { action: "close", agent_id: first.item.subagentId },
      {
        runId: "parent_run",
        callId: "close",
        messageId: "message",
        sessionId: "parent_1",
        signal: new AbortController().signal,
      },
    );
    expect(
      formatToolResultContentForModel({
        tool: "subagent_close",
        content: result.output ?? "",
        metadata: result.metadata,
      }),
    ).not.toContain("old failure");
    await host.dispose();
  });

  it("counts a background child turn but not its completed record", async () => {
    const { host, turn } = createHostFixture();
    let release!: (result: AgentRunResult) => void;
    turn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await runAndObserve(host, {
      parentSessionId: "parent_1",
      role: "explore",
      prompt: "background",
      mode: "background",
    });
    await vi.waitFor(() => {
      expect(turn).toHaveBeenCalled();
    });
    expect(host.hasActiveWork()).toBe(true);
    release({
      finalOutput: "done",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    });
    await vi.waitFor(() => {
      expect(host.hasActiveWork()).toBe(false);
    });
    await host.dispose();
  });

  it("inherits the runtime model while retaining the parent reasoning intent", async () => {
    const { host, turn, createInstance, getRuntimeAgent } = createHostFixture({
      getParentReasoning: () => mergeReasoningIntent({ effort: "high" }),
    });
    getRuntimeAgent.mockResolvedValue({
      config: { name: "explore", mode: "subagent" },
      isSubagent: true,
      tools: {},
    });
    await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      role: "explore",
      prompt: "inspect",
    });
    expect(createInstance.mock.calls[0][0].modelId).toBe("fake-model");
    expect(turn.mock.calls[0][0].reasoning?.effort).toBe("high");
    await host.dispose();
  });

  it("keeps a completed run's cancelled status and reason instead of reporting a failed report", async () => {
    const { host, turn } = createHostFixture();
    turn.mockResolvedValueOnce({
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: false,
      runStatus: "cancelled",
      error: "run cancelled by owner",
    });

    const result = await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      role: "explore",
      prompt: "inspect",
    });

    expect(result.item.status).toBe("cancelled");
    expect(result.item.error).toBe("run cancelled by owner");
    expect(result.item.closedAt).toBeUndefined();
    await expect(
      runAndObserve(host, {
        mode: "foreground",
        parentSessionId: "parent_1",
        subagentId: result.item.subagentId,
        prompt: "resume",
      }),
    ).resolves.toMatchObject({ success: true, output: "subagent output" });
    await host.dispose();
  });
  it("inherits the invoking parent context instead of another sibling scope", async () => {
    const getParentReasoning = vi.fn((_sessionId: string, scope?: string) =>
      mergeReasoningIntent(
        scope === "sibling-off" ? { enabled: false } : { effort: "high" },
      ),
    );
    const { host, turn } = createHostFixture({ getParentReasoning });
    await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      parentContextScopeId: "sibling-off",
      role: "explore",
      prompt: "inspect",
    });
    expect(turn.mock.calls[0][0].reasoning?.enabled).toBe(false);
    expect(getParentReasoning).toHaveBeenCalledWith("parent_1", "sibling-off");
    await host.dispose();
  });
  it("rejects the foreground caller when durable claim persistence fails", async () => {
    const { host, turn } = createHostFixture({
      store: new ClaimFailingStore(),
    });

    await expect(
      runAndObserve(host, {
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
      runAndObserve(host, {
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "inspect",
        role: "explore",
      }),
    ).rejects.toThrow("claim persistence failed");
    expect(turn).not.toHaveBeenCalled();
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

    const result = await runAndObserve(host, {
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
      runAndObserve(host, {
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

    const result = await runAndObserve(host, {
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
      runAndObserve(host, {
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

    const first = await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "inspect",
      role: "explore",
    });
    const closed = await host.close({
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
    });

    expect(typeof closed.item?.closedAt).toBe("number");
    expect(closed.item?.status).toBe("cancelled");
    await expect(
      runAndObserve(host, {
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "try again",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("Subagent is closed");
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it("reports a coded terminal error when close wins during stop admission", async () => {
    const { host, store } = createHostFixture();
    const first = await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "inspect",
      role: "explore",
    });
    const input = {
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
    };
    const get = store.get.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "get").mockImplementationOnce(async (query) => {
      await gate;
      return get(query);
    });
    const stopping = host.stop(input);
    const rejection = expect(stopping).rejects.toMatchObject({
      code: "SUBAGENT_CLOSED",
    });
    await host.close(input);
    release();
    await rejection;
    await expect(
      host.stop({ parentSessionId: "parent_1", subagentId: "missing" }),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
  });

  it("keeps a running subagent cancelled when close wins the race", async () => {
    const { host, turn, store } = createHostFixture();
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

    const running = runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "slow",
      role: "explore",
    });
    await flushMicrotasks();
    const status = await host.list({ parentSessionId: "parent_1" });
    const subagentId = status.items[0]?.subagentId;
    if (!subagentId) {
      throw new Error("Expected running subagent");
    }

    const closeTool = createSubagentTools(host).find(
      (tool) => tool.name === "agent",
    );
    if (!closeTool) throw new Error("Missing subagent_close tool");
    const closed = await closeTool.execute(
      { action: "close", agent_id: subagentId },
      {
        runId: "parent_run",
        callId: "close",
        messageId: "message",
        sessionId: "parent_1",
        signal: new AbortController().signal,
      },
    );
    expect(closed.output).toContain("subagent closed");
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
    expect(result.item.error).toBe("subagent closed");
    expect(result.output).toBe("subagent closed");
    await expect(
      store.get({ parentSessionId: "parent_1", subagentId }),
    ).resolves.toMatchObject({ status: "cancelled" });
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

    const running = runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "slow",
      role: "explore",
    });
    await vi.waitUntil(async () => {
      const status = await host.list({ parentSessionId: "parent_1" });
      return status.items[0]?.status === "running";
    });

    await expect(
      host.list({ parentSessionId: "parent_1" }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          currentInput: expect.objectContaining({ prompt: "slow" }) as unknown,
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
    const first = await runAndObserve(host, {
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

    const second = runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
      timeoutMs: 5_000,
    });
    await vi.waitUntil(async () => {
      const status = await host.list({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      });
      return status.items[0]?.status === "running";
    });
    await expect(
      host.list({
        parentSessionId: "parent_1",
        subagentId: first.item.subagentId,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          currentInput: expect.objectContaining({
            prompt: "second",
            timeoutMs: 5_000,
          }) as unknown,
          ownerId: "owner_current",
          ownerPid: 101,
          timeoutMs: 30 * 60 * 1_000,
        }),
      ],
    });

    complete();
    await expect(second).resolves.toMatchObject({
      item: { status: "completed", timeoutMs: 30 * 60 * 1_000 },
    });
  });

  it("keeps a scheduled background subagent cancelled when close happens before active registration", async () => {
    const { getRuntimeAgent, host, turn, store } = createHostFixture();
    let resolveRuntimeAgent!: () => void;
    getRuntimeAgent
      .mockResolvedValueOnce({
        config: {
          maxSteps: 5,
          mode: "subagent",
          name: "explore",
        },
        isSubagent: true,
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

    const created = await runAndObserve(host, {
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

    const saved = await store.get({
      parentSessionId: "parent_1",
      subagentId: created.item.subagentId,
    });
    expect(saved).toMatchObject({
      status: "cancelled",
    });
    expect(typeof saved?.closedAt).toBe("number");
    expect(saved?.output).not.toBe("late success");
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

      const running = runAndObserve(host, {
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

      const running = runAndObserve(host, {
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

    const running = runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "slow",
      role: "explore",
      signal: controller.signal,
      timeoutMs: 50,
    });
    await vi.waitFor(
      () => {
        expect(turn).toHaveBeenCalledTimes(1);
      },
      { interval: 1 },
    );
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
      runAndObserve(host, {
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
      runAndObserve(host, {
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "too long",
        role: "explore",
        timeoutMs: 7_200_001,
      }),
    ).rejects.toThrow("must not exceed 1800000ms");
  });

  it("retains interrupted execution without creating an instance when disposal wins admission", async () => {
    const executionStore = new InMemorySubagentExecutionStore();
    const { getRuntimeAgent, host, store } = createHostFixture({
      executionStore,
    });
    let releaseAgent!: (agent: RuntimeAgent) => void;
    getRuntimeAgent.mockImplementationOnce(
      () =>
        new Promise<RuntimeAgent>((resolve) => {
          releaseAgent = resolve;
        }),
    );
    const accepted = await host.run({
      requesterRunId: "dispose_root",
      requesterMessageId: "message",
      requestId: "held_create",
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
      tools: {},
    });
    await flushMicrotasks();
    expect(
      (
        await executionStore.get({
          parentSessionId: "parent_1",
          executionId: accepted.execution.executionId,
        })
      )?.status,
    ).toBe("interrupted");
    expect(await store.listByParent("parent_1")).toEqual([]);
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
    const first = await runAndObserve(firstFixture.host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    const secondFixture = createHostFixture({ existingChild: child, store });

    await expect(
      runAndObserve(secondFixture.host, {
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
      runAndObserve(host, {
        mode: "foreground",
        parentSessionId: "parent_1",
        prompt: "first",
        role: "explore",
      }),
      runAndObserve(host, {
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
    const status = await host.list({ parentSessionId: "parent_1" });
    expect(status.items.map((item) => item.subagentId)).toEqual(
      expect.arrayContaining([first.item.subagentId, second.item.subagentId]),
    );
    await expect(store.listByParent("parent_1")).resolves.toHaveLength(2);
  });
});
