import { describe, expect, it, vi } from "vitest";
import type { AgentInstance, AgentRunResult } from "../core/agents/index.js";
import type { RuntimeAgent } from "../agents/index.js";
import type { Session } from "../services/session/index.js";
import { executeGoalExecutionInterrupt } from "./goal-execution-control.js";

describe("goal execution control adapter contract", () => {
  it("cleans every captured goal root even when the current primary was stopped", async () => {
    const interrupted: string[] = [];
    await executeGoalExecutionInterrupt(
      {
        sessionId: "session_goal",
        goalId: "goal",
        rootRunIds: ["old-root", "current-root"],
        expectedRunId: "current-root",
        reason: "budget reached",
        includePrimary: true,
      },
      {
        activeRunId: () => "current-root",
        promptOwner: () => "goal",
        promptSessionId: () => "session_goal",
        abortPromptRun: () => Promise.resolve(true),
        waitForPromptRunReadyOrIdle: () => Promise.resolve(),
        interruptSubagentsByRootRun: (runId): Promise<void> => {
          interrupted.push(runId);
          return Promise.resolve();
        },
      },
    );
    expect(interrupted).toEqual(["old-root", "current-root"]);
  });
  it("preserves all goal background roots after an ordinary primary Stop", async () => {
    const interrupted: string[] = [];
    await executeGoalExecutionInterrupt(
      {
        sessionId: "session_goal",
        rootRunIds: ["old-root", "current-root"],
        expectedRunId: "current-root",
        preserveBackground: true,
        reason: "interrupted",
        includePrimary: true,
      },
      {
        activeRunId: () => "current-root",
        promptOwner: () => "goal",
        promptSessionId: () => "session_goal",
        abortPromptRun: () => Promise.resolve(true),
        waitForPromptRunReadyOrIdle: () => Promise.resolve(),
        interruptSubagentsByRootRun: (runId): Promise<void> => {
          interrupted.push(runId);
          return Promise.resolve();
        },
      },
    );
    expect(interrupted).toEqual([]);
  });
  it("T-8 interrupts only-background work when there is no primary run", async () => {
    const abortPromptRun = vi.fn(() => Promise.resolve(false));
    const interruptSubagentsByRootRun = vi.fn(() => Promise.resolve());

    await executeGoalExecutionInterrupt(
      {
        includePrimary: true,
        reason: "safety pause",
        sessionId: "session_goal",
        expectedRunId: "run_goal",
      },
      {
        abortPromptRun,
        activeRunId: () => undefined,
        interruptSubagentsByRootRun,
        promptOwner: () => undefined,
        promptSessionId: () => undefined,
        waitForPromptRunReadyOrIdle: () => Promise.resolve(),
      },
    );

    expect(abortPromptRun).not.toHaveBeenCalled();
    expect(interruptSubagentsByRootRun).toHaveBeenCalledOnce();
    expect(interruptSubagentsByRootRun).toHaveBeenCalledWith(
      "run_goal",
      "safety pause",
    );
  });

  it("does not issue a second parent interrupt after the primary run tree aborts", async () => {
    const abortPromptRun = vi.fn(() => Promise.resolve(true));
    const interruptSubagentsByRootRun = vi.fn(() => Promise.resolve());

    await executeGoalExecutionInterrupt(
      {
        includePrimary: true,
        reason: "user pause",
        sessionId: "session_goal",
        expectedRunId: "run_goal",
      },
      {
        abortPromptRun,
        activeRunId: () => "run_goal",
        interruptSubagentsByRootRun,
        promptOwner: () => "goal",
        promptSessionId: () => "session_goal",
        waitForPromptRunReadyOrIdle: () => Promise.resolve(),
      },
    );

    expect(abortPromptRun).toHaveBeenCalledWith("run_goal");
    expect(interruptSubagentsByRootRun).not.toHaveBeenCalled();
  });
});

it.each([
  "executor-switch",
  "background-only",
  "no-root",
  "matching-root",
] as const)(
  "G28 isolates actual descendant state for %s while a user tree is active",
  async (scenario) => {
    const { TestSessionSubagentHost: SessionSubagentHost } =
      await import("../core/testing/runtime-model-fixtures.js");
    const { InMemorySubagentInstanceStore, InMemorySubagentExecutionStore } =
      await import("../agents/index.js");
    const parent: import("../services/session/index.js").Session = {
      id: "parent",
      agentName: "build",
      childrenIds: [],
      createdAt: 1,
      updatedAt: 1,
      isSubagent: false,
      projectId: "project",
      workingDirectory: process.cwd(),
      stats: { messageCount: 0 },
      status: "active",
      title: "parent",
    };
    const child = {
      ...parent,
      id: "child",
      isSubagent: true,
      parentId: parent.id,
    };
    const store = new InMemorySubagentInstanceStore();
    const executions = new InMemorySubagentExecutionStore();
    const signals = new Map<string, AbortSignal>();
    let ids = 0;
    const host = new SessionSubagentHost({
      executionStore: executions,
      store,
      agentManager: {
        getRuntimeAgent: (role): Promise<RuntimeAgent> =>
          Promise.resolve({
            config: { mode: "subagent", name: role ?? "explore", maxSteps: 5 },
            isSubagent: true,
            tools: {},
          }),
      },
      modelId: "fake",
      resolveRequester: (
        input,
      ): Promise<{ rootRunId: string; rootSessionId: string }> =>
        Promise.resolve({
          rootRunId: input.requesterRunId,
          rootSessionId: parent.id,
        }),
      sessionManager: {
        get: (id): Promise<Session> =>
          Promise.resolve(id === parent.id ? parent : child),
        create: (): Promise<Session> => Promise.resolve(child),
      },
      createSubagentId: (): string => `child-${String(++ids)}`,
      createRunId: (): string => `child-run-${String(ids)}`,
      instanceFactory: {
        create: (identity): AgentInstance => ({
          identity,
          contextScope:
            {} as import("../core/agents/index.js").AgentInstance["contextScope"],
          turn: (input): Promise<AgentRunResult> =>
            new Promise((resolve) => {
              if (!input.signal)
                throw new Error("Expected actual host abort signal");
              signals.set(input.prompt, input.signal);
              const finish = (): void => {
                resolve({
                  success: false,
                  sessionId: child.id,
                  mode: "waitForCompletion",
                  error: "interrupted",
                });
              };
              if (input.signal.aborted) finish();
              else
                input.signal.addEventListener("abort", finish, { once: true });
            }),
        }),
      },
    });
    const goalPrimary = new AbortController();
    const userPrimary = new AbortController();
    let active = "goal-root";
    let owner: "goal" | "user" = "goal";
    let readyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      readyEntered = resolve;
    });
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const aborts: string[] = [];
    const deps = {
      activeRunId: (): string => active,
      promptOwner: (): "goal" | "user" => owner,
      promptSessionId: (): string => parent.id,
      waitForPromptRunReadyOrIdle: async (): Promise<void> => {
        readyEntered();
        await ready;
      },
      abortPromptRun: async (runId: string): Promise<boolean> => {
        aborts.push(runId);
        (runId === "goal-root" ? goalPrimary : userPrimary).abort();
        await host.interruptByRootRun(runId, "primary stopped");
        return true;
      },
      interruptSubagentsByRootRun: async (
        runId: string,
        reason: string,
      ): Promise<void> => {
        await host.interruptByRootRun(runId, reason);
      },
    };
    try {
      const goal = await host.run({
        parentSessionId: parent.id,
        requesterRunId: "goal-root",
        requesterMessageId: "g",
        requestId: "goal-child",
        prompt: "goal child",
        role: "explore",
      });
      const user = await host.run({
        parentSessionId: parent.id,
        requesterRunId: "user-root",
        requesterMessageId: "u",
        requestId: "user-child",
        prompt: "user child",
        role: "explore",
      });
      await vi.waitFor(() => {
        expect(signals.size).toBe(2);
      });
      const interruption = executeGoalExecutionInterrupt(
        {
          sessionId: parent.id,
          reason: "captured goal stop",
          includePrimary: scenario !== "background-only",
          ...(scenario === "no-root" ? {} : { expectedRunId: "goal-root" }),
        },
        deps,
      );
      if (scenario !== "background-only") {
        await entered;
        if (scenario !== "matching-root") {
          active = "user-root";
          owner = "user";
        }
        releaseReady();
      }
      await interruption;
      expect(aborts).toEqual(scenario === "matching-root" ? ["goal-root"] : []);
      expect(goalPrimary.signal.aborted).toBe(scenario === "matching-root");
      expect(userPrimary.signal.aborted).toBe(false);
      expect(signals.get("user child")?.aborted).toBe(false);
      expect(signals.get("goal child")?.aborted).toBe(scenario !== "no-root");
      const goalState = await store.get({
        parentSessionId: parent.id,
        subagentId: goal.execution.subagentId,
      });
      const userState = await store.get({
        parentSessionId: parent.id,
        subagentId: user.execution.subagentId,
      });
      expect(goalState?.status).toBe(
        scenario === "no-root" ? "running" : "interrupted",
      );
      expect(userState?.status).toBe("running");
      expect(goalState?.closedAt).toBeUndefined();
      expect(userState?.closedAt).toBeUndefined();
    } finally {
      releaseReady();
      await host.dispose();
    }
  },
);
