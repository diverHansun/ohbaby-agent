import {
  mergeReasoningIntent,
  type ReasoningIntent,
} from "../services/interface-providers/reasoning.js";
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
  SubagentRunInput,
  SubagentRunResult,
} from "./subagents/types.js";
import { InMemorySubagentExecutionStore } from "./subagents/execution-store.js";
import { SessionSubagentHost } from "./subagent-host.js";
import { createSubagentTools } from "../tools/subagent.js";
import { formatToolResultContentForModel } from "../core/context/tool-metadata-projection.js";

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
    const status = await host.status({
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
    await host.status({
      parentSessionId: input.parentSessionId,
      subagentId: result.execution.subagentId,
    })
  ).items.at(0);
  if (!item) throw new Error("Instance did not bind");
  return { ...result, item };
}

describe("SessionSubagentHost", () => {
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
      ).rejects.toThrow(/closed/);
    },
  );
  it("replays an accepted continuation after its reusable instance is closed", async () => {
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
    expect((await host.run(input)).execution.executionId).toBe(
      follow.execution.executionId,
    );
    expect(turn).toHaveBeenCalledTimes(2);
  });
  it("keeps a queued prompt out of turn history until start and uses its reserved message ID", async () => {
    const { host, turn } = createHostFixture();
    let finishFirst!: (value: AgentRunResult) => void;
    turn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const base = {
      requesterRunId: "root",
      requesterMessageId: "message",
      parentSessionId: "parent_1",
      mode: "background" as const,
    };
    const first = await host.run({
      ...base,
      requestId: "first",
      prompt: "first",
      role: "explore",
    });
    await vi.waitFor(() => {
      expect(turn).toHaveBeenCalledTimes(1);
    });
    const second = await host.run({
      ...base,
      requestId: "second",
      prompt: "second",
      subagentId: first.execution.subagentId,
    });
    expect(second.execution.status).toBe("queued");
    expect(second.execution.childUserMessageId).toEqual(expect.any(String));
    expect(turn).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0]?.[0].initialUserMessageId).toBe(
      first.execution.childUserMessageId,
    );
    finishFirst({
      finalOutput: "first done",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    });
    await vi.waitFor(() => {
      expect(turn).toHaveBeenCalledTimes(2);
    });
    expect(turn.mock.calls[1]?.[0]).toMatchObject({
      prompt: "second",
      initialUserMessageId: second.execution.childUserMessageId,
    });
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
  it("admits accepted continuations in sequence when the earlier child bind stalls", async () => {
    const executionStore = new InMemorySubagentExecutionStore();
    const { host, turn } = createHostFixture({ executionStore });
    let finishInitial!: (result: AgentRunResult) => void;
    turn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitial = resolve;
        }),
    );
    const base = {
      requesterRunId: "root",
      requesterMessageId: "message",
      parentSessionId: "parent_1",
      mode: "background" as const,
    };
    const initial = await host.run({
      ...base,
      requestId: "initial",
      prompt: "initial",
      role: "explore",
    });
    await vi.waitFor(() => {
      expect(turn).toHaveBeenCalledTimes(1);
    });
    const originalBind = executionStore.bindChild.bind(executionStore);
    let releaseBind!: () => void;
    let enterBind!: () => void;
    const enteredBind = new Promise<void>((resolve) => {
      enterBind = resolve;
    });
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    let delayed = false;
    vi.spyOn(executionStore, "bindChild").mockImplementation(
      async (lookup, childIdentity, at) => {
        if (!delayed) {
          delayed = true;
          enterBind();
          await bindGate;
        }
        return originalBind(lookup, childIdentity, at);
      },
    );
    const first = await host.run({
      ...base,
      requestId: "first",
      prompt: "first",
      subagentId: initial.execution.subagentId,
    });
    await enteredBind;
    const second = await host.run({
      ...base,
      requestId: "second",
      prompt: "second",
      subagentId: initial.execution.subagentId,
    });
    expect([
      first.execution.delegationSequence,
      second.execution.delegationSequence,
    ]).toEqual([2, 3]);
    releaseBind();
    await vi.waitFor(async () => {
      expect(
        (await host.status({ parentSessionId: "parent_1" })).items[0]
          ?.pendingQueue,
      ).toHaveLength(2);
    });
    finishInitial({
      finalOutput: "done",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    });
    await vi.waitFor(() => {
      expect(turn).toHaveBeenCalledTimes(3);
    });
    expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "initial",
      "first",
      "second",
    ]);
  });
  it("skips a sealed root queue entry without stranding the next root", async () => {
    const executionStore = new InMemorySubagentExecutionStore();
    const { host, turn } = createHostFixture({ executionStore });
    let finishFirst!: (value: AgentRunResult) => void;
    turn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const base = {
      requesterMessageId: "message",
      parentSessionId: "parent_1",
      mode: "background" as const,
    };
    const first = await host.run({
      ...base,
      requesterRunId: "C",
      requestId: "C",
      prompt: "C",
      role: "explore",
    });
    await vi.waitFor(
      () => {
        expect(turn).toHaveBeenCalledTimes(1);
      },
      {
        interval: 1,
      },
    );
    await host.run({
      ...base,
      requesterRunId: "A",
      requestId: "A",
      prompt: "A",
      subagentId: first.execution.subagentId,
    });
    await host.run({
      ...base,
      requesterRunId: "B",
      requestId: "B",
      prompt: "B",
      subagentId: first.execution.subagentId,
    });
    await vi.waitFor(
      async () => {
        expect(
          (await host.status({ parentSessionId: "parent_1" })).items[0]
            ?.pendingQueue,
        ).toHaveLength(2);
      },
      { interval: 1 },
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = executionStore.interruptRoot.bind(executionStore);
    vi.spyOn(executionStore, "interruptRoot").mockImplementation(
      async (...args) => {
        await held;
        return original(...args);
      },
    );
    const interrupted = host.interruptByRootRun("A");
    finishFirst({
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
      finalOutput: "C done",
    });
    try {
      await vi.waitFor(
        () => {
          expect(turn.mock.calls.map(([input]) => input.prompt)).toEqual([
            "C",
            "B",
          ]);
        },
        { interval: 1, timeout: 200 },
      );
    } finally {
      release();
      await interrupted;
      await host.dispose();
    }
  });
  it.each(["body", "empty", "failed", "interrupted", "timed_out"] as const)(
    "delivers the foreground %s result even with a later background input queued",
    async (outcome) => {
      const { host, turn } = createHostFixture();
      let release!: (result: AgentRunResult) => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      turn.mockImplementationOnce(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            release = resolve;
            started();
          }),
      );
      const tool = createSubagentTools(host).find(
        (candidate) => candidate.name === "subagent_run",
      );
      if (!tool) throw new Error("Missing subagent_run tool");
      const first = tool.execute(
        {
          prompt: "first",
          role: "explore",
          mode: "foreground",
          ...(outcome === "timed_out" ? { timeout_ms: 100 } : {}),
        },
        {
          runId: "parent_run",
          callId: "first",
          messageId: "message",
          sessionId: "parent_1",
          signal: new AbortController().signal,
        },
      );
      await startedPromise;
      try {
        await runAndObserve(host, {
          mode: "background",
          parentSessionId: "parent_1",
          subagentId: "subagent_1",
          prompt: "second",
        });
        if (outcome !== "timed_out") {
          release(
            outcome === "body" || outcome === "empty"
              ? {
                  mode: "waitForCompletion",
                  sessionId: "child_1",
                  success: true,
                  finalOutput: outcome === "body" ? "FIRST REPORT" : "",
                }
              : {
                  mode: "waitForCompletion",
                  sessionId: "child_1",
                  success: false,
                  runStatus: outcome,
                  error: "first turn stopped",
                },
          );
        }
        const result = await first;
        expect(result.output).not.toContain("status: queued");
        expect(result.output).toContain("pending_inputs: 1");
        if (outcome === "body") {
          expect(result.output).toContain(
            "<subagent_output>\nFIRST REPORT\n</subagent_output>",
          );
        } else if (outcome === "empty") {
          expect(result.output).toContain("program_note: No output.");
        } else {
          expect(result.output).toContain(`status: ${outcome}`);
          expect(result.output).toContain("<subagent_error>");
          expect(result.output).not.toContain("<subagent_output>");
        }
      } finally {
        release({
          mode: "waitForCompletion",
          sessionId: "child_1",
          success: true,
          finalOutput: "late",
        });
        await host.dispose();
      }
    },
  );

  it.each(["failed", "cancelled", "interrupted", "timed_out"] as const)(
    "does not deliver an earlier %s turn as a paused foreground input's result",
    async (outcome) => {
      const { host, turn } = createHostFixture();
      let release!: (result: AgentRunResult) => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      turn.mockImplementationOnce(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            release = resolve;
            started();
          }),
      );
      const first = await runAndObserve(host, {
        mode: "background",
        parentSessionId: "parent_1",
        role: "explore",
        prompt: "first",
        ...(outcome === "timed_out" ? { timeoutMs: 100 } : {}),
      });
      await startedPromise;
      const tool = createSubagentTools(host).find(
        (candidate) => candidate.name === "subagent_run",
      );
      if (!tool) throw new Error("Missing subagent_run tool");
      try {
        const second = tool.execute(
          {
            subagent_id: first.item.subagentId,
            prompt: "second",
            mode: "foreground",
          },
          {
            runId: "parent_run",
            callId: "second",
            messageId: "message",
            sessionId: "parent_1",
            signal: new AbortController().signal,
          },
        );
        await flushMicrotasks();
        if (outcome !== "timed_out")
          release({
            mode: "waitForCompletion",
            sessionId: "child_1",
            success: false,
            runStatus: outcome,
            error: "first failed",
          });
        const result = await second;
        const visible = formatToolResultContentForModel({
          tool: "subagent_run",
          content: result.output ?? "",
          metadata: result.metadata,
        });
        expect(visible).toContain("status: paused");
        expect(visible).toContain("has not run");
        expect(visible).not.toContain("first failed");
        expect(visible).not.toContain("Subagent timed out");
        expect(visible).not.toContain("<subagent_error>");
        expect(visible).not.toContain("<subagent_output>");
        expect(turn).toHaveBeenCalledTimes(1);
        expect(
          (await host.status({ parentSessionId: "parent_1" })).items[0]
            ?.pendingQueue,
        ).toMatchObject([{ prompt: "second" }]);
      } finally {
        release({
          mode: "waitForCompletion",
          sessionId: "child_1",
          success: true,
          finalOutput: "late",
        });
        await host.dispose();
      }
    },
  );

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
      (candidate) => candidate.name === "subagent_close",
    );
    if (!tool) throw new Error("Missing subagent_close tool");
    const result = await tool.execute(
      { subagent_id: first.item.subagentId },
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

  it("uses the configured child model while retaining the parent reasoning intent", async () => {
    const { host, turn, createInstance, getRuntimeAgent } = createHostFixture({
      getParentReasoning: () => mergeReasoningIntent({ effort: "high" }),
    });
    getRuntimeAgent.mockResolvedValue({
      config: { name: "explore", mode: "subagent", model: "child-model" },
      isSubagent: true,
      tools: {},
    });
    await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      role: "explore",
      prompt: "inspect",
    });
    expect(createInstance.mock.calls[0][0].modelId).toBe("child-model");
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
  it("captures parent intent at enqueue and renews it for a reused child task", async () => {
    let parentReasoning = mergeReasoningIntent({ effort: "high" });
    const { host, turn } = createHostFixture({
      getParentReasoning: () => parentReasoning,
    });
    let finishFirst: ((result: AgentRunResult) => void) | undefined;
    turn.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      role: "explore",
      prompt: "first",
    });
    await flushMicrotasks();
    parentReasoning = mergeReasoningIntent({ enabled: false, effort: "high" });
    await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
      prompt: "second",
    });
    parentReasoning = mergeReasoningIntent({ effort: "low" });
    finishFirst?.({
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
      finalOutput: "done",
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(turn.mock.calls.map(([request]) => request.reasoning)).toEqual([
      {
        enabled: true,
        effort: "high",
        explicit: { enabled: false, effort: true },
      },
      {
        enabled: false,
        effort: "high",
        explicit: { enabled: true, effort: true },
      },
    ]);
    await runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      subagentId: first.item.subagentId,
      prompt: "third",
    });
    expect(turn.mock.calls[2][0].reasoning?.effort).toBe("low");
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();

    await expect(
      runAndObserve(host, {
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

    const running = runAndObserve(host, {
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

    const closeTool = createSubagentTools(host).find(
      (tool) => tool.name === "subagent_close",
    );
    if (!closeTool) throw new Error("Missing subagent_close tool");
    const closed = await closeTool.execute(
      { subagent_id: subagentId },
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

    const running = runAndObserve(host, {
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

    const first = await runAndObserve(host, {
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
    await runAndObserve(host, {
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
          pendingQueue: [],
          status: "interrupted",
        }),
      ],
    });
    expect(turn).toHaveBeenCalledTimes(1);
    await expect(
      runAndObserve(host, {
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "third",
        subagentId: first.item.subagentId,
      }),
    ).rejects.toThrow("Subagent host is disposed");
  });

  it("retains interrupted execution without creating an instance when disposal wins admission", async () => {
    const { getRuntimeAgent, host, store } = createHostFixture();
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
        await host.status({
          parentSessionId: "parent_1",
          executionId: accepted.execution.executionId,
        })
      ).executions[0].status,
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();

    const second = runAndObserve(host, {
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
    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    const controller = new AbortController();
    const queued = runAndObserve(host, {
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first active",
      role: "explore",
    });
    const second = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second active",
      role: "research",
    });
    await runAndObserve(host, {
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
          pendingQueue: [expect.objectContaining({ prompt: "first queued" })],
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();

    const queued = runAndObserve(host, {
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });
    await runAndObserve(host, {
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
      environment: { workdir: "/queued-workdir" } as ToolExecutionEnvironment,
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });
    await runAndObserve(host, {
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
            expect.objectContaining({
              prompt: "second",
              workdir: "/queued-workdir",
            }),
            expect.objectContaining({ prompt: "third" }),
          ],
          status: "failed",
        }),
      ],
    });

    const resumed = await runAndObserve(host, {
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
    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    const queued = runAndObserve(host, {
      mode: "foreground",
      parentSessionId: "parent_1",
      prompt: "foreground queued",
      subagentId: first.item.subagentId,
    });
    await flushMicrotasks();

    failFirst();
    await expect(queued).resolves.toMatchObject({
      item: {
        pendingQueue: [
          expect.objectContaining({ prompt: "foreground queued" }),
        ],
        status: "failed",
      },
      success: false,
    });
    await runAndObserve(host, {
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

      const first = await runAndObserve(host, {
        mode: "background",
        parentSessionId: "parent_1",
        prompt: "first",
        role: "explore",
        timeoutMs: 5,
      });
      await vi.advanceTimersByTimeAsync(0);
      await runAndObserve(host, {
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
            pendingQueue: [expect.objectContaining({ prompt: "second" })],
            status: "timed_out",
          }),
        ],
      });

      const resumed = await runAndObserve(host, {
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "second",
      subagentId: first.item.subagentId,
    });
    await runAndObserve(host, {
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
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
          pendingQueue: [expect.objectContaining({ prompt: "replacement" })],
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
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

    const resumed = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "resume",
      subagentId: first.item.subagentId,
    });

    expect(resumed.item).toMatchObject({
      pendingQueue: [
        expect.objectContaining({ prompt: "replacement" }),
        expect.objectContaining({ prompt: "resume" }),
      ],
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
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
    await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "resume",
      subagentId: first.item.subagentId,
    });

    await expect(
      host.interruptByParent("parent_1", "parent stopped"),
    ).resolves.toEqual([
      expect.objectContaining({
        pendingQueue: [
          expect.objectContaining({ prompt: "replacement" }),
          expect.objectContaining({ prompt: "resume" }),
        ],
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

    const first = await runAndObserve(host, {
      mode: "background",
      parentSessionId: "parent_1",
      prompt: "first",
      role: "explore",
    });
    await flushMicrotasks();
    await runAndObserve(host, {
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

    const resumed = runAndObserve(host, {
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
    const status = await host.status({ parentSessionId: "parent_1" });
    expect(status.items.map((item) => item.subagentId)).toEqual(
      expect.arrayContaining([first.item.subagentId, second.item.subagentId]),
    );
    await expect(store.listByParent("parent_1")).resolves.toHaveLength(2);
  });
});
