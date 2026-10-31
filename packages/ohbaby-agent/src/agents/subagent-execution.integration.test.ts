import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ShellJobRegistry } from "../tools/shell-job-registry.js";
import {
  TestSessionSubagentHost as SessionSubagentHost,
  type TestSubagentRunInput,
} from "../core/testing/runtime-model-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { mergeReasoningIntent } from "ohbaby-llm";
import { testRunModel } from "../core/testing/model-fixtures.js";
import type { RuntimeAgent } from "./types.js";
import type { AgentInstance } from "../core/agents/index.js";
import type { Session } from "../services/session/index.js";

import { InMemorySubagentInstanceStore } from "./subagents/in-memory-store.js";
import { InMemorySubagentExecutionStore } from "./subagents/execution-store.js";
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
  input: (
    id: string,
    patch?: Partial<TestSubagentRunInput>,
  ) => TestSubagentRunInput;
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
    patch: Partial<TestSubagentRunInput> = {},
  ): TestSubagentRunInput => ({
    requesterRunId: "root_A",
    requesterMessageId: "message",
    requestId: id,
    parentSessionId: "parent",
    awaitResult: true,
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
  it("releases transient Host tables after completed work and empty root or parent interruption", async () => {
    const onStateChanged = vi.fn();
    const f = fixture({ onStateChanged });
    const first = await f.host.run(f.input("first"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    for (let i = 0; i < 20; i++) {
      await f.host.interruptByRootRun(`empty-${String(i)}`);
      await f.host.interruptByParent(`removed-${String(i)}`, "removed", {
        closeAdmission: true,
      });
    }
    await f.host.close({
      parentSessionId: "parent",
      subagentId: first.execution.subagentId,
    });
    const internals = f.host as unknown as Record<
      string,
      Map<unknown, unknown> | Set<unknown>
    >;
    for (const name of [
      "leases",
      "active",
      "parentSessionLocks",
      "subagentLocks",
      "settlingTurns",
      "sealedRoots",
      "sealedParents",
      "closedSubagents",
      "invocationLocks",
      "admissionTails",
      "executionJobs",
      "rootByExecution",
      "executionBudgets",
      "closeOperations",
      "closingScopes",
      "admissions",
    ]) {
      expect(internals[name].size, name).toBe(0);
    }
    expect(onStateChanged).toHaveBeenCalledWith("parent");
  });

  it("closes legacy queued inputs with their text and reason before a new execution, without replay", async () => {
    const f = fixture();
    const first = await f.host.run(f.input("first"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    await f.store.update(first.execution.subagentId, {
      pendingQueue: [{ prompt: "legacy queued task" }],
      updatedAt: 2,
    });
    await f.host.send({
      ...f.input("new message"),
      subagentId: first.execution.subagentId,
    });
    const saved = await f.store.get({
      parentSessionId: "parent",
      subagentId: first.execution.subagentId,
    });
    expect(saved?.pendingQueue).toEqual([
      {
        prompt: "legacy queued task",
        closedAt: expect.any(Number) as number,
        closeReason: "legacy queued input is no longer executable",
      },
    ]);
    expect(f.turn.mock.calls.map(([input]) => input.prompt)).not.toContain(
      "legacy queued task",
    );
    const before = saved?.pendingQueue;
    await f.host.close({
      parentSessionId: "parent",
      subagentId: first.execution.subagentId,
    });
    expect(
      (
        await f.store.get({
          parentSessionId: "parent",
          subagentId: first.execution.subagentId,
        })
      )?.pendingQueue,
    ).toEqual(before);
  });

  it("shares six slots across modes, keeps each parent independent, and refuses idle sends without disturbing siblings", async () => {
    const sessions = new Map<string, Session>(
      ["parent", "other"].map((id) => [
        id,
        { id, isSubagent: false, workingDirectory: "/repo" } as Session,
      ]),
    );
    const f = fixture({
      cleanupWaitMs: 1,
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
    const idle = await f.host.run(f.input("idle"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => finish.promise);
    const batches = ["parent", "other"].map((parentSessionId) =>
      Array.from({ length: 7 }, (_, i) =>
        f.host.spawn(
          f.input(`${parentSessionId}-${String(i)}`, {
            parentSessionId,
            requesterRunId: `${parentSessionId}-root`,
            awaitResult: i % 2 === 0,
          }),
        ),
      ),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(13);
    });
    for (const parentSessionId of ["parent", "other"]) {
      expect(
        (await f.executionStore.list({ parentSessionId, limit: 20 })).filter(
          (entry) => entry.status === "running",
        ),
      ).toHaveLength(6);
    }
    expect(
      await f.host.send({
        ...f.input("busy idle", { awaitResult: false }),
        subagentId: idle.execution.subagentId,
      }),
    ).toMatchObject({ started: false });
    const active = (
      await f.executionStore.list({ parentSessionId: "parent", limit: 20 })
    ).filter((entry) => entry.status === "running");
    const stopping = f.host.stop({
      parentSessionId: "parent",
      subagentId: active[0].subagentId,
    });
    expect(
      (await f.host.list({ parentSessionId: "parent" })).runtime?.find(
        (entry) => entry.subagentId === active[0].subagentId,
      )?.settling,
    ).toBe(true);
    expect((await stopping).cleanup).toBe("unconfirmed");
    const signals = f.turn.mock.calls.slice(1).map(([input]) => input.signal);
    expect(signals.filter((signal) => signal?.aborted)).toHaveLength(1);
    finish.resolve({
      mode: "waitForCompletion",
      sessionId: "child",
      success: true,
      finalOutput: "done",
    });
    const results = await Promise.all(
      batches.map((batch) => Promise.all(batch)),
    );
    for (const batch of results) {
      expect(batch.filter((result) => result.started)).toHaveLength(6);
      expect(batch.filter((result) => !result.execution)).toHaveLength(1);
    }
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
  });

  it("reopens a persisted idle instance by its old ID after Host restart and keeps closed IDs terminal", async () => {
    const first = fixture();
    const created = await first.host.run(first.input("persisted"));
    await vi.waitFor(() => {
      expect(first.host.hasActiveWork()).toBe(false);
    });
    const restarted = fixture({
      store: first.store,
      executionStore: first.executionStore,
    });
    const resumed = await restarted.host.send({
      ...restarted.input("after restart"),
      subagentId: created.execution.subagentId,
    });
    expect(resumed).toMatchObject({
      started: true,
      execution: { subagentId: created.execution.subagentId },
    });
    expect(resumed.execution?.executionId).not.toBe(
      created.execution.executionId,
    );
    await restarted.host.close({
      parentSessionId: "parent",
      subagentId: created.execution.subagentId,
    });
    const again = fixture({
      store: first.store,
      executionStore: first.executionStore,
    });
    await expect(
      again.host.send({
        ...again.input("closed after restart"),
        subagentId: created.execution.subagentId,
      }),
    ).rejects.toThrow("closed");
  });

  it("keeps the captured model and reasoning during a running send after parent settings change", async () => {
    let model = testRunModel("original-model");
    let reasoning = mergeReasoningIntent({ effort: "low" });
    const getParentRunModel = vi.fn(() => model);
    const f = fixture({
      getParentRunModel,
      getParentReasoning: () => reasoning,
      acceptExecutionMessage: () => Promise.resolve({ accepted: true }),
    });
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => finish.promise);
    const first = await f.host.run(
      f.input("model-fixed", { awaitResult: false }),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(1);
    });
    model = testRunModel("changed-model");
    reasoning = mergeReasoningIntent({ effort: "high" });
    const sent = await f.host.send({
      ...f.input("more work"),
      subagentId: first.execution.subagentId,
    });
    expect(sent).toMatchObject({ started: false, accepted: true });
    expect(getParentRunModel).toHaveBeenCalledTimes(1);
    expect(f.turn.mock.calls[0][0].runModel.client.config.model).toBe(
      "original-model",
    );
    expect(f.turn.mock.calls[0][0].reasoning?.effort).toBe("low");
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

  it("returns a naturally completed execution slot with detached shells, seals its commands, and closes every shell of the instance", async () => {
    const stopped = new WeakSet<ChildProcess>();
    const killTree = vi.fn((child: ChildProcess) => {
      stopped.add(child);
      child.emit("close", null, "SIGTERM");
      return { status: "confirmed" as const };
    });
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (child): "stopped" | "running" =>
        stopped.has(child) ? "stopped" : "running",
    });
    const f = fixture({
      cleanupExecution: ({ execution, reason }) => {
        if (!execution.childRunId) return Promise.resolve({ confirmed: true });
        registry.sealRootRun(execution.childRunId);
        return reason === "closed" ||
          execution.status === "interrupted" ||
          execution.status === "cancelled"
          ? registry.cleanupRootRun(execution.childRunId)
          : registry.observeExecutionCleanup(execution.childRunId);
      },
      onClosed: ({ sessionId, contextScopeId }) =>
        registry.cleanupScope(sessionId, contextScopeId),
    });
    const createChild = (): ChildProcess =>
      Object.assign(new EventEmitter(), {
        pid: 424242,
      }) as unknown as ChildProcess;
    f.turn.mockImplementation(async (input) => {
      const execution = (
        await f.executionStore.list({ parentSessionId: "parent", limit: 20 })
      ).find((entry) => entry.childRunId === input.runId);
      if (!input.runId || !execution?.childScopeId || !execution.childSessionId)
        throw new Error("missing child identity");
      registry.start({
        child: createChild,
        background: true,
        timeoutMs: 10000,
        sessionId: execution.childSessionId,
        contextScopeId: execution.childScopeId,
        owner: {
          rootRunId: input.runId,
          sessionId: execution.childSessionId,
          messageId: "message",
          callId: input.runId,
        },
      });
      return {
        mode: "waitForCompletion",
        sessionId: "child",
        success: true,
        finalOutput: "detached",
      };
    });
    const first = await f.host.run(f.input("detached first"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    expect(registry.hasActiveWork(first.execution.childRunId)).toBe(true);
    if (!first.execution.childRunId) throw new Error("missing child run");
    const launch = vi.fn(createChild);
    expect(() =>
      registry.start({
        child: launch,
        background: true,
        timeoutMs: 10000,
        sessionId: "child",
        contextScopeId: first.execution.childScopeId,
        owner: {
          rootRunId: first.execution.childRunId,
          sessionId: "child",
          messageId: "late",
          callId: "late",
        },
      }),
    ).toThrow("closed");
    expect(launch).not.toHaveBeenCalled();
    await f.host.send({
      ...f.input("detached second"),
      subagentId: first.execution.subagentId,
    });
    const sibling = await f.host.run(f.input("sibling"));
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    expect(
      (
        await f.host.close({
          parentSessionId: "parent",
          subagentId: first.execution.subagentId,
        })
      ).cleanup,
    ).toBe("confirmed");
    expect(killTree).toHaveBeenCalledTimes(2);
    expect(registry.hasActiveWork(sibling.execution.childRunId)).toBe(true);
    await f.host.close({
      parentSessionId: "parent",
      subagentId: sibling.execution.subagentId,
    });
    await registry.dispose();
  });

  it("cannot release a replacement execution's slot through late signals from the previous execution", async () => {
    const oldCleanup = deferred<undefined>();
    const oldCaller = new AbortController();
    const cleanupExecution = vi
      .fn<NonNullable<SessionSubagentHostOptions["cleanupExecution"]>>()
      .mockResolvedValue({ confirmed: true })
      .mockResolvedValueOnce({ confirmed: false, settled: oldCleanup.promise });
    const f = fixture({ cleanupWaitMs: 1, cleanupExecution });
    const first = await f.host.run(
      f.input("old", { signal: oldCaller.signal }),
    );
    await vi.waitFor(() => {
      expect(cleanupExecution).toHaveBeenCalledTimes(1);
    });
    expect(f.host.hasActiveWork()).toBe(true);
    oldCleanup.resolve(undefined);
    await vi.waitFor(() => {
      expect(f.host.hasActiveWork()).toBe(false);
    });
    const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
    f.turn.mockImplementation(() => finish.promise);
    const replacement = await f.host.send({
      ...f.input("replacement", {
        awaitResult: false,
        requesterRunId: "root_B",
      }),
      subagentId: first.execution.subagentId,
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        f.host.spawn(
          f.input(`sibling-${String(i)}`, {
            awaitResult: false,
            requesterRunId: "root_B",
          }),
        ),
      ),
    );
    await vi.waitFor(() => {
      expect(f.turn).toHaveBeenCalledTimes(7);
    });
    oldCaller.abort("late old caller stop");
    oldCleanup.resolve(undefined);
    await Promise.resolve();
    expect(
      await f.host.spawn(
        f.input("still full", { awaitResult: false, requesterRunId: "root_B" }),
      ),
    ).toMatchObject({ started: false });
    expect(
      f.turn.mock.calls.slice(1).some(([input]) => input.signal?.aborted),
    ).toBe(false);
    expect(
      (
        await f.executionStore.get({
          parentSessionId: "parent",
          executionId: replacement.execution?.executionId ?? "missing",
        })
      )?.status,
    ).toBe("running");
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

  it.each(["failed", "timed_out", "stop"] as const)(
    "closes accepted messages and retains durable unprocessed facts after %s",
    async (kind) => {
      let closed: readonly { inputId: string; text: string; reason: string }[] =
        [];
      const closeExecutionInputs = vi.fn<
        NonNullable<SessionSubagentHostOptions["closeExecutionInputs"]>
      >(({ reason }) => {
        closed = [{ inputId: "message", text: "unread follow-up", reason }];
        return Promise.resolve(closed);
      });
      const f = fixture({
        cleanupWaitMs: 1,
        closeExecutionInputs,
        readExecutionInputs: () => Promise.resolve(closed),
        acceptExecutionMessage: () => Promise.resolve({ accepted: true }),
      });
      const entered = deferred<undefined>();
      const finish = deferred<Awaited<ReturnType<AgentInstance["turn"]>>>();
      f.turn.mockImplementation((input) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            finish.resolve({
              mode: "waitForCompletion",
              sessionId: "child",
              success: false,
              error: "interrupted",
            });
          },
          { once: true },
        );
        entered.resolve(undefined);
        return finish.promise;
      });
      const running = f.host.spawn(
        f.input("running", {
          timeoutMs: kind === "timed_out" ? 100 : undefined,
        }),
      );
      await entered.promise;
      const execution = (await f.executionStore.listByRootRun("root_A"))[0];
      expect(
        await f.host.send({
          ...f.input("unread follow-up"),
          subagentId: execution.subagentId,
        }),
      ).toMatchObject({ started: false, accepted: true });
      if (kind === "failed")
        finish.resolve({
          mode: "waitForCompletion",
          sessionId: "child",
          success: false,
          error: "model failed",
        });
      if (kind === "stop")
        await f.host.stop({
          parentSessionId: "parent",
          subagentId: execution.subagentId,
          expectedExecutionId: execution.executionId,
        });
      await running;
      await vi.waitFor(() => {
        expect(f.host.hasActiveWork()).toBe(false);
      });
      expect(closeExecutionInputs).toHaveBeenCalledTimes(1);
      expect(closed).toEqual([
        {
          inputId: "message",
          text: "unread follow-up",
          reason: kind === "stop" ? "stopped" : kind,
        },
      ]);
      expect(
        (await f.host.list({ parentSessionId: "parent" })).runtime?.[0]
          .unprocessedMessages,
      ).toEqual(closed);
    },
  );

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
    await f.host.run(f.input("first", { awaitResult: false }));
    await f.host.run(f.input("second", { awaitResult: false }));
    await f.host.run(
      f.input("other", {
        awaitResult: false,
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
      let removed = false;
      const f = fixture({
        resolveRequester: (input) => {
          if (removed)
            return Promise.reject(new Error("parent session closed"));
          return Promise.resolve({
            rootSessionId: input.parentSessionId,
            rootRunId: input.requesterRunId,
          });
        },
      });
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
      await f.host.run(f.input("preparing", { awaitResult: false }));
      await entered.promise;
      removed = true;
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
    const started = await f.host.run(f.input("work", { awaitResult: false }));
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
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
    await expect(
      f.host.stop({
        parentSessionId: "parent",
        subagentId: "missing",
        expectedExecutionId: "stale",
      }),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
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
          ...f.input(prompt, { awaitResult: false }),
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
        f.host.run(f.input(`close-${String(i)}`, { awaitResult: false })),
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
      await f.host.spawn(f.input("during-close-write", { awaitResult: false })),
    ).toMatchObject({ started: false });
    closedWrite.resolve(undefined);
    expect(await closing).toMatchObject({ cleanup: "unconfirmed" });
    expect(
      await f.host.spawn(
        f.input("during-scope-cleanup", { awaitResult: false }),
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
        f.host.spawn(f.input(`capacity-${String(i)}`, { awaitResult: false })),
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
      f.input("initial", { awaitResult: false }),
    );
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    const sent = await f.host.send({
      ...f.input("message", { awaitResult: true }),
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
        f.host.run(f.input(`active-${String(i)}`, { awaitResult: false })),
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
      await f.host.spawn(f.input("too-early", { awaitResult: false })),
    ).toMatchObject({ started: false });
    cleanup.resolve(undefined);
    expect(
      await f.host.spawn(f.input("turn-still-exiting", { awaitResult: false })),
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
      await f.host.spawn(f.input("after-cleanup", { awaitResult: false })),
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
      const saved = await f.store.get({ subagentId, parentSessionId });
      await f.store.update(subagentId, {
        pendingQueue: [
          ...(saved?.pendingQueue ?? []),
          { executionId, rootRunId, prompt: executionId },
        ],
        updatedAt: 2,
      });
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
      {
        executionId: "queued-A",
        rootRunId: "root_A",
        prompt: "queued-A",
        closedAt: expect.any(Number) as number,
        closeReason: "stopped",
      },
      { executionId: "queued-B", rootRunId: "root_B", prompt: "queued-B" },
    ]);
    expect(
      (
        await f.store.get({
          parentSessionId: "child-requester",
          subagentId: "nested-instance",
        })
      )?.pendingQueue,
    ).toEqual([
      {
        executionId: "nested-A",
        rootRunId: "root_A",
        prompt: "nested-A",
        closedAt: expect.any(Number) as number,
        closeReason: "stopped",
      },
    ]);
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
    await f.host.run(f.input("one", { awaitResult: false }));
    await f.host.run(f.input("two", { awaitResult: false }));
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
        f.host.run(f.input("late", { awaitResult: false })),
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
    const a = await f.host.run(f.input("one", { awaitResult: false }));
    await started.promise;
    const sent = await f.host.send({
      ...f.input("unread", { awaitResult: false }),
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
    const accepted = await f.host.run(f.input("one", { awaitResult: false }));
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
    const receipt = await f.host.run(f.input("call", { awaitResult: false }));
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
    const input = f.input("same", { awaitResult: false });
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
  it("keeps two same-instance reports and terminal reasons independently", async () => {
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
    expect(records.every((r) => r.mode === "background")).toBe(true);
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
