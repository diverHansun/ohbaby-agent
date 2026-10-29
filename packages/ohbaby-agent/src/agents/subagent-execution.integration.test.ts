import { TestSessionSubagentHost as SessionSubagentHost } from "../core/testing/runtime-model-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { mergeReasoningIntent } from "ohbaby-llm";
import { testRunModel } from "../core/testing/model-fixtures.js";
import type { RuntimeAgent } from "./types.js";
import type { AgentInstance } from "../core/agents/index.js";
import type { Session } from "../services/session/index.js";

import { InMemorySubagentInstanceStore } from "./subagents/in-memory-store.js";
import { InMemorySubagentExecutionStore } from "./subagents/execution-store.js";
import type { SubagentRunInput } from "./subagents/types.js";
import type { SessionSubagentHostOptions } from "./subagent-host.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(extra: Partial<SessionSubagentHostOptions> = {}): {
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
    workingDirectory: "/repo",
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
        turn: async (input): ReturnType<AgentInstance["turn"]> => {
          await input.onInputReady?.();
          return turn(input);
        },
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
    ...extra,
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

describe("session-owned subagent lifecycle", () => {
  it("reads the current parent model and reasoning again when an idle send starts a new execution", async () => {
    let model = testRunModel("first-model");
    let reasoning = mergeReasoningIntent({ effort: "low" });
    const f = fixture({
      getParentRunModel: () => model,
      getParentReasoning: () => reasoning,
    });
    const first = await f.host.run(f.input("first"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    model = testRunModel("second-model");
    reasoning = mergeReasoningIntent({ effort: "high" });
    const second = await f.host.send({
      ...f.input("follow-up"),
      subagentId: first.execution.subagentId,
    });
    expect(second).toMatchObject({ started: true });
    expect(second.execution?.executionId).not.toBe(first.execution.executionId);
    expect(
      f.turn.mock.calls.map(([input]) => [
        input.runModel.client.config.model,
        input.reasoning?.effort,
      ]),
    ).toEqual([
      ["first-model", "low"],
      ["second-model", "high"],
    ]);
  });

  it("interrupts every instance of the removed parent without touching another parent", async () => {
    const sessions = new Map<string, Session>(
      ["parent", "other"].map((id) => [
        id,
        { id, isSubagent: false, workingDirectory: "/repo" } as Session,
      ]),
    );
    const f = fixture({
      sessionManager: {
        get: (id) => Promise.resolve(sessions.get(id) ?? null),
        create: (_directory, options) => {
          const child = {
            id: `${options?.parentId ?? "unknown"}_child`,
            parentId: options?.parentId,
            isSubagent: true,
            workingDirectory: "/repo",
          } as Session;
          sessions.set(child.id, child);
          return Promise.resolve(child);
        },
      },
    });
    const turn = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => turn.promise);
    await f.host.run(f.input("first", { mode: "background" }));
    await f.host.run(f.input("second", { mode: "background" }));
    await f.host.run(
      f.input("other", {
        mode: "background",
        parentSessionId: "other",
        requesterRunId: "root_B",
      }),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(3);
    });
    await f.host.interruptByParent("parent", "parent session removed", {
      closeAdmission: true,
    });
    expect(f.turn.mock.calls.map(([input]) => input.signal?.aborted)).toEqual([
      true,
      true,
      false,
    ]);
    expect((await f.executionStore.listByRootRun("root_B"))[0].status).toBe(
      "running",
    );
    turn.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "done",
    });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });

  it.each(["create", "bind"])(
    "never starts a prepared child after parent removal while %s is pending",
    async (phase) => {
      const f = fixture();
      const entered = deferred<undefined>();
      const release = deferred<undefined>();
      if (phase === "create") {
        f.create.mockImplementation(async () => {
          entered.resolve(undefined);
          await release.promise;
          return {
            id: "child",
            parentId: "parent",
            isSubagent: true,
            workingDirectory: "/repo",
          } as Session;
        });
      } else {
        const bind = f.executionStore.bindChild.bind(f.executionStore);
        vi.spyOn(f.executionStore, "bindChild").mockImplementation(
          async (...args) => {
            entered.resolve(undefined);
            await release.promise;
            return bind(...args);
          },
        );
      }
      await f.host.run(f.input("preparing", { mode: "background" }));
      await entered.promise;
      await f.host.interruptByParent("parent", "parent session removed", {
        closeAdmission: true,
      });
      release.resolve(undefined);
      await vi.waitFor(() => {
        expect(f.host.hasActiveWork()).toBe(false);
      });
      expect(f.turn).not.toHaveBeenCalled();
      expect((await f.executionStore.listByRootRun("root_A"))[0].status).toBe(
        "interrupted",
      );
      await expect(f.host.spawn(f.input("late-request"))).rejects.toThrow(
        /closed/,
      );
    },
  );

  it("validates the original text when retrying an accepted send after execution settlement", async () => {
    let receipt:
      | import("./subagents/execution-store.js").SubagentExecutionRecord
      | undefined;
    const f = fixture({
      getExecutionMessage: () =>
        Promise.resolve(receipt ? { execution: receipt } : undefined),
      acceptExecutionMessage: ({ execution, message }) => {
        if (message !== "original update")
          return Promise.reject(
            new Error("Execution message idempotency conflict"),
          );
        receipt = execution;
        return Promise.resolve({ accepted: true });
      },
    });
    const turn = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => turn.promise);
    const started = await f.host.run(f.input("work", { mode: "background" }));
    const send = f.input("send", {
      subagentId: started.execution.subagentId,
      prompt: "original update",
    });
    await expect(
      f.host.send({ ...send, subagentId: started.execution.subagentId }),
    ).resolves.toMatchObject({ accepted: true, started: false });
    turn.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "done",
    });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    await expect(
      f.host.send({ ...send, subagentId: started.execution.subagentId }),
    ).resolves.toMatchObject({ accepted: true, started: false });
    await expect(
      f.host.send({
        ...send,
        subagentId: started.execution.subagentId,
        prompt: "changed update",
      }),
    ).rejects.toThrow("idempotency conflict");
    expect(f.turn).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign and missing stop targets before reporting an expected execution mismatch", async () => {
    const f = fixture();
    const first = await f.host.run(f.input("owned"));
    await expect(
      f.host.stop({
        parentSessionId: "foreign",
        subagentId: first.execution.subagentId,
        expectedExecutionId: "stale",
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      f.host.stop({
        parentSessionId: "parent",
        subagentId: "missing",
        expectedExecutionId: "stale",
      }),
    ).rejects.toThrow(/not found/);
  });
  it("reuses unconfirmed close cleanup and preserves the original durable close identity", async () => {
    const cleanup = deferred<undefined>();
    const onClosed = vi.fn(() =>
      Promise.resolve({
        confirmed: false,
        settled: cleanup.promise,
      }),
    );
    const f = fixture({ cleanupWaitMs: 1, onClosed });
    const original = await f.host.run(f.input("completed"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    const target = {
      parentSessionId: "parent",
      subagentId: original.execution.subagentId,
    };
    const first = await f.host.close(target);
    expect(first.cleanup).toBe("unconfirmed");
    const second = await f.host.close(target);
    expect(second.cleanup).toBe("unconfirmed");
    expect(second.item?.closedAt).toBe(first.item?.closedAt);
    expect(onClosed).toHaveBeenCalledTimes(1);
    cleanup.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.host.close(target)).toMatchObject({ cleanup: "confirmed" });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect((await f.host.list({ parentSessionId: "parent" })).items).toEqual(
      [],
    );
    await expect(
      f.host.send({ ...f.input("reuse"), subagentId: target.subagentId }),
    ).rejects.toThrow(/closed/);
  });

  it("a parent stop interrupts only its foreground execution", async () => {
    const f = fixture();
    const signals = new Map<string, AbortSignal>();
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation((input) => {
      if (!input.signal) throw new Error("Expected execution signal");
      signals.set(input.prompt, input.signal);
      if (input.prompt === "background") return finish.promise;
      return new Promise((resolve) =>
        input.signal?.addEventListener(
          "abort",
          () => {
            resolve({
              mode: "waitForCompletion",
              sessionId: "child",
              success: false,
              error: "stopped",
              runStatus: "interrupted",
            });
          },
          { once: true },
        ),
      );
    });
    await f.host.run(f.input("background", { mode: "background" }));
    const foreground = f.host.run(f.input("foreground"));
    await vi.waitFor(() => {
      expect(signals.size).toBe(2);
    });
    await f.host.interruptForegroundByRootRun("root_A");
    expect(signals.get("foreground")?.aborted).toBe(true);
    expect(signals.get("background")?.aborted).toBe(false);
    expect((await foreground).execution).toMatchObject({
      status: "interrupted",
      delivery: { state: "foreground" },
    });
    finish.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "background result",
    });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });

  it("concurrent sends to an idle instance share one new execution and reject a stale stop", async () => {
    const received: string[] = [];
    const f = fixture({
      acceptExecutionMessage: ({ message }) => {
        received.push(message);
        return Promise.resolve({ accepted: true });
      },
    });
    const original = await f.host.run(f.input("original"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => finish.promise);
    const [first, second] = await Promise.all(
      ["first", "second"].map((prompt) =>
        f.host.send({
          ...f.input(prompt, { mode: "background" }),
          subagentId: original.execution.subagentId,
        }),
      ),
    );
    expect(first).toMatchObject({ started: true });
    expect(second).toMatchObject({ started: false, accepted: true });
    expect(second.execution?.executionId).toBe(first.execution?.executionId);
    expect(received).toEqual(["second"]);
    expect(
      await f.executionStore.list({ parentSessionId: "parent" }),
    ).toHaveLength(2);
    expect(
      await f.host.stop({
        parentSessionId: "parent",
        subagentId: original.execution.subagentId,
        expectedExecutionId: original.execution.executionId,
      }),
    ).toMatchObject({ stopped: false });
    expect(f.turn.mock.calls.at(-1)?.[0].signal?.aborted).toBe(false);
    finish.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "done",
    });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });
  it("holds the closing execution slot while durable close and instance cleanup are still pending", async () => {
    const closedWrite = deferred<undefined>();
    const scope = deferred<undefined>();
    const f = fixture({
      cleanupWaitMs: 1,
      onClosed: () =>
        Promise.resolve({ confirmed: false, settled: scope.promise }),
    });
    f.turn.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                mode: "waitForCompletion",
                sessionId: "child",
                success: false,
                error: "closed",
                runStatus: "interrupted",
              });
            },
            { once: true },
          );
        }),
    );
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        f.host.run(f.input(`close-${String(i)}`, { mode: "background" })),
      ),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(6);
    });
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation(async (id, patch) => {
      if (patch.closedAt !== undefined) await closedWrite.promise;
      return update(id, patch);
    });
    const closing = f.host.close({
      parentSessionId: "parent",
      subagentId: all[0].execution.subagentId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      await f.host.spawn(f.input("during-close-write", { mode: "background" })),
    ).toMatchObject({ started: false });
    closedWrite.resolve(undefined);
    expect(await closing).toMatchObject({ cleanup: "unconfirmed" });
    expect(
      await f.host.spawn(
        f.input("during-scope-cleanup", { mode: "background" }),
      ),
    ).toMatchObject({ started: false });
    scope.resolve(undefined);
    await vi.waitFor(async () => {
      expect(
        (await f.host.list({ parentSessionId: "parent" })).items,
      ).toHaveLength(5);
    });
    await f.host.interruptByParent("parent");
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });
  it("reserves all six execution slots before asynchronous creation and rejects the seventh", async () => {
    const f = fixture();
    const createGate = deferred<Session>();
    f.create.mockImplementation(() => createGate.promise);
    const started = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        f.host.spawn(f.input(`capacity-${String(i)}`, { mode: "background" })),
      ),
    );
    expect(started.filter((result) => result.started)).toHaveLength(6);
    expect(started[6].started).toBe(false);
    if (started[6].execution)
      throw new Error("Capacity rejection started an execution");
    expect(typeof started[6].reason).toBe("string");
    expect(started[6].execution).toBeUndefined();
    expect(
      await f.executionStore.list({ parentSessionId: "parent" }),
    ).toHaveLength(6);
    createGate.resolve({
      id: "child",
      parentId: "parent",
      isSubagent: true,
      workingDirectory: "/repo",
    } as Session);
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });

  it("delivers send to the current execution without interruption, a new execution or a queued turn", async () => {
    const received: string[] = [];
    const f = fixture({
      acceptExecutionMessage: ({ message }) => {
        received.push(message);
        return Promise.resolve({ accepted: true });
      },
    });
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    let signal: AbortSignal | undefined;
    f.turn.mockImplementation((input) => {
      signal = input.signal;
      return finish.promise;
    });
    const initial = await f.host.run(
      f.input("initial", { mode: "background" }),
    );
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    const sent = await f.host.send({
      ...f.input("message", { mode: "foreground" }),
      subagentId: initial.execution.subagentId,
    });
    expect(sent).toMatchObject({
      started: false,
      accepted: true,
      execution: {
        executionId: initial.execution.executionId,
        mode: "background",
      },
    });
    expect(received).toEqual(["message"]);
    expect(signal?.aborted).toBe(false);
    expect(
      await f.executionStore.list({ parentSessionId: "parent" }),
    ).toHaveLength(1);
    finish.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "done",
    });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    expect(f.turn).toHaveBeenCalledTimes(1);
  });

  it("keeps a stopped execution slot until its turn and resource cleanup are both confirmed", async () => {
    const cleanup = deferred<undefined>();
    const f = fixture({
      cleanupWaitMs: 1,
      cleanupExecution: () =>
        Promise.resolve({
          confirmed: false,
          settled: cleanup.promise,
        }),
    });
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => finish.promise);
    const executions = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        f.host.run(f.input(`active-${String(i)}`, { mode: "background" })),
      ),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(6);
    });
    const stopped = await f.host.stop({
      parentSessionId: "parent",
      subagentId: executions[0].execution.subagentId,
    });
    expect(stopped.cleanup).toBe("unconfirmed");
    expect(
      await f.host.spawn(f.input("too-early", { mode: "background" })),
    ).toMatchObject({ started: false });
    cleanup.resolve(undefined);
    expect(
      await f.host.spawn(f.input("turn-still-exiting", { mode: "background" })),
    ).toMatchObject({ started: false });
    finish.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "late",
    });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    expect(
      await f.host.spawn(f.input("after-cleanup", { mode: "background" })),
    ).toMatchObject({ started: true });
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });
});

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
  it("closes unconsumed messages on stop and starts a later send with only its new prompt", async () => {
    const messages: { inputId: string; text: string; reason: string }[] = [];
    const f = fixture({
      acceptExecutionMessage: ({ inputId, message }) => {
        messages.push({ inputId, text: message, reason: "stopped" });
        return Promise.resolve({ accepted: true });
      },
      closeExecutionInputs: () => Promise.resolve(messages),
    });
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
                runStatus: "interrupted",
              });
            },
            { once: true },
          );
        }),
    );
    const a = await f.host.run(f.input("one", { mode: "background" }));
    await started.promise;
    const sent = await f.host.send({
      ...f.input("unread", { mode: "background" }),
      subagentId: a.execution.subagentId,
    });
    expect(sent.accepted).toBe(true);
    const stopped = await f.host.stop({
      parentSessionId: "parent",
      subagentId: a.execution.subagentId,
    });
    expect(stopped).toMatchObject({
      cleanup: "confirmed",
      unprocessedMessages: [{ text: "unread", reason: "stopped" }],
    });
    const b = await f.host.send({
      ...f.input("new work", { requesterRunId: "root_B" }),
      subagentId: a.execution.subagentId,
    });
    expect(b).toMatchObject({ started: true, output: "exact report" });
    expect(f.turn.mock.calls.map(([input]) => input.prompt)).toEqual([
      "one",
      "new work",
    ]);
    expect(
      (
        await f.store.get({
          parentSessionId: "parent",
          subagentId: a.execution.subagentId,
        })
      )?.pendingQueue,
    ).toEqual([]);
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
      workingDirectory: "/repo",
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
      workingDirectory: "/repo",
    } as Session);
    await vi.waitFor(async () => {
      expect((await f.executionStore.listByRootRun("root_A"))[0].status).toBe(
        "interrupted",
      );
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.turn).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    expect(await f.executionStore.listByRootRun("root_A")).toHaveLength(1);
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
