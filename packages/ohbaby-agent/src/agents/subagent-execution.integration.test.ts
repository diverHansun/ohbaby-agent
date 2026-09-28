import { describe, expect, it, vi } from "vitest";
import type { RuntimeAgent } from "./types.js";
import type { AgentInstance } from "../core/agents/index.js";
import type { Session } from "../services/session/index.js";
import { SessionSubagentHost } from "./subagent-host.js";
import { InMemorySubagentInstanceStore } from "./subagents/in-memory-store.js";
import { InMemorySubagentExecutionStore } from "./subagents/execution-store.js";
import type { SubagentRunInput } from "./subagents/types.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(): {
  host: SessionSubagentHost;
  store: InMemorySubagentInstanceStore;
  executionStore: InMemorySubagentExecutionStore;
  create: ReturnType<typeof vi.fn<() => Promise<Session>>>;
  turn: ReturnType<typeof vi.fn<AgentInstance["turn"]>>;
  input: (id: string, patch?: Partial<SubagentRunInput>) => SubagentRunInput;
  onFatal: ReturnType<typeof vi.fn>;
  onTerminal: ReturnType<typeof vi.fn>;
} {
  const parent = {
    id: "parent",
    projectRoot: "/repo",
    isSubagent: false,
  } as Session;
  const child = {
    ...parent,
    id: "child",
    isSubagent: true,
    parentId: "parent",
  } as Session;
  const store = new InMemorySubagentInstanceStore();
  const executionStore = new InMemorySubagentExecutionStore();
  const create = vi.fn(() => Promise.resolve(child));
  const turn = vi.fn<AgentInstance["turn"]>(() =>
    Promise.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "exact report",
      terminalReason: "max_steps_finalized",
    }),
  );
  const onFatal = vi.fn();
  const onTerminal = vi.fn();
  let next = 0;
  const host = new SessionSubagentHost({
    agentManager: {
      getRuntimeAgent: (): Promise<RuntimeAgent> =>
        Promise.resolve({
          config: { name: "explore", mode: "subagent", maxSteps: 5 },
          isSubagent: true,
          tools: {},
        }),
    },
    instanceFactory: {
      create: (identity): AgentInstance => ({
        identity,
        turn,
        contextScope: {} as AgentInstance["contextScope"],
      }),
    },
    modelId: "test",
    sessionManager: {
      create,
      get: (id): Promise<Session> =>
        Promise.resolve(id === "parent" ? parent : child),
    },
    store,
    executionStore,
    createSubagentId: (): string => `sub_${String(++next)}`,
    resolveRequester: (
      input,
    ): Promise<{ rootSessionId: string; rootRunId: string }> =>
      Promise.resolve({
        rootSessionId: input.parentSessionId,
        rootRunId: input.requesterRunId,
      }),
    onFatal,
    onTerminal,
  });
  const input = (
    id: string,
    patch: Partial<SubagentRunInput> = {},
  ): SubagentRunInput => ({
    requesterRunId: "root_A",
    requesterMessageId: "message",
    requestId: id,
    parentSessionId: "parent",
    mode: "foreground",
    role: "explore",
    prompt: id,
    ...patch,
  });
  return {
    host,
    store,
    executionStore,
    create,
    turn,
    input,
    onFatal,
    onTerminal,
  };
}

describe("accepted subagent execution host", () => {
  it("withdraws persisted root inputs outside the active map and retries after queue persistence fails", async () => {
    const f = fixture();
    const completed = await f.host.run(f.input("completed"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    for (const [executionId, rootRunId, parentSessionId, subagentId] of [
      ["queued-A", "root_A", "parent", completed.execution.subagentId],
      ["queued-B", "root_B", "parent", completed.execution.subagentId],
      ["nested-A", "root_A", "child-requester", "nested-instance"],
    ]) {
      await f.executionStore.accept({
        executionId,
        rootRunId,
        parentSessionId,
        subagentId,
        rootSessionId: "parent",
        requesterRunId: `requester-${executionId}`,
        requestId: executionId,
        requesterScopeId: "scope",
        mode: "background",
        prompt: executionId,
        createdAt: 1,
      });
      if (subagentId === "nested-instance") {
        await f.store.create({
          subagentId,
          parentSessionId,
          sessionId: "nested-child",
          contextScopeId: subagentId,
          role: "explore",
          initialPrompt: executionId,
          status: "interrupted",
          pendingQueue: [],
          createdAt: 1,
          updatedAt: 1,
        });
      }
      await f.store.appendPendingQueue(
        subagentId,
        { executionId, rootRunId, prompt: executionId },
        2,
      );
    }
    expect(f.host.hasActiveWork()).toBe(false);
    const originalUpdate = f.store.update.bind(f.store);
    const failedSave = vi
      .spyOn(f.store, "update")
      .mockRejectedValueOnce(new Error("queue disk failure"));
    await expect(
      f.host.interruptByRootRun("root_A", "stopped"),
    ).rejects.toThrow("queue disk failure");
    failedSave.mockImplementation(originalUpdate);
    await f.host.interruptByRootRun("root_A", "stopped");
    expect(
      (
        await f.store.get({
          parentSessionId: "parent",
          subagentId: completed.execution.subagentId,
        })
      )?.pendingQueue,
    ).toEqual([
      { executionId: "queued-B", rootRunId: "root_B", prompt: "queued-B" },
    ]);
    expect(
      (
        await f.store.get({
          parentSessionId: "child-requester",
          subagentId: "nested-instance",
        })
      )?.pendingQueue,
    ).toEqual([]);
    expect(
      Object.fromEntries(
        (await f.executionStore.listByRootRun("root_A")).map((record) => [
          record.executionId,
          record.status,
        ]),
      ),
    ).toEqual({
      [completed.execution.executionId]: "completed",
      "queued-A": "interrupted",
      "nested-A": "interrupted",
    });
    expect((await f.executionStore.listByRootRun("root_B"))[0].status).toBe(
      "queued",
    );
    expect(f.turn).toHaveBeenCalledTimes(1);
  });
  it("aborts every current child synchronously before a root interruption save can fail", async () => {
    const f = fixture();
    const signals: AbortSignal[] = [];
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation((input) => {
      if (input.signal) signals.push(input.signal);
      return finish.promise;
    });
    await f.host.run(f.input("one", { mode: "background" }));
    await f.host.run(f.input("two", { mode: "background" }));
    await vi.waitFor(() => {
      expect(signals).toHaveLength(2);
    });
    const failure = vi
      .spyOn(f.executionStore, "interruptRoot")
      .mockRejectedValue(new Error("root disk failure"));
    try {
      const stopped = f.host.interruptByRootRun("root_A", "stopped");
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await expect(stopped).rejects.toThrow("root disk failure");
      await expect(
        f.host.run(f.input("late", { mode: "background" })),
      ).rejects.toThrow(/closed/);
    } finally {
      failure.mockRestore();
      finish.resolve({
        mode: "waitForCompletion",
        sessionId: "child",
        success: false,
        error: "stopped",
        runStatus: "interrupted",
      });
      await f.host.dispose();
    }
  });
  it("withdraws old root queued inputs while a new root can reuse the instance", async () => {
    const f = fixture();
    const started = deferred<undefined>();
    f.turn.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          started.resolve(undefined);
          input.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                mode: "waitForCompletion",
                sessionId: "child",
                success: false,
                error: "stopped",
                runStatus: "cancelled",
              });
            },
            { once: true },
          );
        }),
    );
    const a = await f.host.run(f.input("one", { mode: "background" }));
    await started.promise;
    const queued = await f.host.run(
      f.input("old queued", {
        mode: "background",
        subagentId: a.execution.subagentId,
      }),
    );
    await f.host.interruptByRootRun("root_A", "stopped");
    const b = await f.host.run(
      f.input("new work", {
        requesterRunId: "root_B",
        subagentId: a.execution.subagentId,
      }),
    );
    expect(b.output).toBe("exact report");
    expect(f.turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "one",
      "new work",
    ]);
    expect(
      (
        await f.executionStore.get({
          parentSessionId: "parent",
          executionId: queued.execution.executionId,
        })
      )?.status,
    ).toBe("interrupted");
  });
  it("closes an accepted instance before its child creation completes", async () => {
    const f = fixture();
    const gate = deferred<Session>();
    f.create.mockImplementation(() => gate.promise);
    const accepted = await f.host.run(f.input("one", { mode: "background" }));
    await f.host.close({
      parentSessionId: "parent",
      subagentId: accepted.execution.subagentId,
    });
    gate.resolve({
      id: "child",
      parentId: "parent",
      isSubagent: true,
      projectRoot: "/repo",
    } as Session);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.turn).not.toHaveBeenCalled();
    expect((await f.executionStore.listByRootRun("root_A"))[0].status).toBe(
      "cancelled",
    );
  });
  it("rejects missing requester identity before launching", async () => {
    const f = fixture();
    await expect(
      f.host.run(f.input("call", { requesterRunId: "" })),
    ).rejects.toThrow(/identity|requester/i);
    expect(f.turn).not.toHaveBeenCalled();
  });
  it("persists accepted membership before held creation and never starts after root interruption", async () => {
    const f = fixture();
    const gate = deferred<Session>();
    f.create.mockImplementation(() => gate.promise);
    const receipt = await f.host.run(f.input("call", { mode: "background" }));
    expect(receipt.execution).toMatchObject({
      status: "queued",
      rootRunId: "root_A",
    });
    expect(receipt.execution.childRunId).toBeUndefined();
    await f.host.interruptByRootRun("root_A", "stopped");
    gate.resolve({
      id: "child",
      parentId: "parent",
      isSubagent: true,
      projectRoot: "/repo",
    } as Session);
    await vi.waitFor(async () => {
      expect((await f.executionStore.listByRootRun("root_A"))[0].status).toBe(
        "interrupted",
      );
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.turn).not.toHaveBeenCalled();
    await expect(
      f.host.run(f.input("late", { mode: "background" })),
    ).rejects.toThrow(/closed|stopped|interrupt/i);
  });
  it("reuses an invocation and returns only background acceptance even for fast completion", async () => {
    const f = fixture();
    const input = f.input("same", { mode: "background" });
    const [a, b] = await Promise.all([f.host.run(input), f.host.run(input)]);
    expect(a.execution.executionId).toBe(b.execution.executionId);
    expect(a.output).toBeUndefined();
    expect(b.output).toBeUndefined();
    await vi.waitFor(() => {
      expect(f.onTerminal).toHaveBeenCalledTimes(1);
    });
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(await f.executionStore.listByRootRun("root_A")).toHaveLength(1);
  });
  it("keeps two same-instance foreground reports and terminal reasons independently", async () => {
    const f = fixture();
    const a = await f.host.run(f.input("one"));
    f.turn.mockResolvedValueOnce({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "second",
    });
    const b = await f.host.run(
      f.input("two", { subagentId: a.execution.subagentId }),
    );
    expect(a.output).toBe("exact report");
    expect(b.output).toBe("second");
    expect(a.execution.reason).toBe("max_steps_finalized");
    const records = await f.executionStore.listByRootRun("root_A");
    expect(records.map((r) => r.output)).toEqual(["exact report", "second"]);
    expect(records.every((r) => r.delivery.state === "foreground")).toBe(true);
  });
  it("does not let late cancellation of A affect B on the same instance", async () => {
    const f = fixture();
    const a = await f.host.run(f.input("one"));
    const gate = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementationOnce(() => gate.promise);
    const b = f.host.run(
      f.input("two", {
        requesterRunId: "root_B",
        subagentId: a.execution.subagentId,
      }),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(2);
    });
    await f.host.interruptByRootRun("root_A", "late stop");
    gate.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "B result",
    });
    expect((await b).output).toBe("B result");
    expect((await f.executionStore.listByRootRun("root_B"))[0].status).toBe(
      "completed",
    );
  });
  it("surfaces terminal persistence failure without publishing successful terminal", async () => {
    const f = fixture();
    vi.spyOn(f.executionStore, "finish").mockRejectedValue(
      new Error("result database failed"),
    );
    await expect(f.host.run(f.input("one"))).rejects.toThrow(
      "result database failed",
    );
    expect(f.onFatal).toHaveBeenCalled();
    expect(f.onTerminal).not.toHaveBeenCalled();
  });

  it("keeps the saved result but fails the root when instance projection persistence fails", async () => {
    const f = fixture();
    vi.spyOn(f.store, "finishRun").mockRejectedValue(
      new Error("instance database failed"),
    );
    await expect(f.host.run(f.input("one"))).rejects.toThrow(
      "instance database failed",
    );
    expect((await f.executionStore.listByRootRun("root_A"))[0]).toMatchObject({
      status: "completed",
      output: "exact report",
    });
    expect(f.onFatal).toHaveBeenCalled();
  });
  it("rejects excess new timeout and normalizes old instance timeout on a new execution", async () => {
    const f = fixture();
    await expect(
      f.host.run(f.input("too-long", { timeoutMs: 1_800_001 })),
    ).rejects.toThrow(/1800000/);
    const a = await f.host.run(f.input("one"));
    const original = await f.store.get({
      parentSessionId: "parent",
      subagentId: a.execution.subagentId,
    });
    if (!original) throw new Error("Missing bound instance");
    // Re-create the legacy persisted instance without changing its historical execution.
    const legacy = {
      ...original,
      subagentId: "legacy",
      contextScopeId: "legacy",
      timeoutMs: 7_200_000,
    };
    await f.store.create(legacy);
    const b = await f.host.run(f.input("two", { subagentId: "legacy" }));
    expect(b.execution.timeoutMs).toBe(1_800_000);
    expect(
      (await f.store.get({ parentSessionId: "parent", subagentId: "legacy" }))
        ?.timeoutMs,
    ).toBe(7_200_000);
  });
});
