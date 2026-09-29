import { describe, expect, it, vi } from "vitest";
import type {
  AgentInstance,
  AgentInstanceFactory,
  AgentRunResult,
} from "../../../packages/ohbaby-agent/src/core/agents/index.js";
import type { Session } from "../../../packages/ohbaby-agent/src/services/session/index.js";
import {
  InMemorySubagentInstanceStore,
  SessionSubagentHost,
} from "../../../packages/ohbaby-agent/src/agents/index.js";
import { InMemorySubagentExecutionStore } from "../../../packages/ohbaby-agent/src/agents/subagents/execution-store.js";
import type { RuntimeAgent } from "../../../packages/ohbaby-agent/src/agents/index.js";
import {
  GoalService,
  InMemoryGoalPersistence,
} from "../../../packages/ohbaby-agent/src/goals/index.js";

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

function createFixture(options: { readonly safetyCapTurns?: number } = {}) {
  const child: Session = {
    ...parent,
    agentName: "subagent-container",
    id: "child_1",
    isSubagent: true,
    parentId: parent.id,
    title: "Subagents",
  };
  const sessions = new Map<string, Session>([[parent.id, parent]]);
  const turn = vi.fn<AgentInstance["turn"]>(
    (input) =>
      new Promise<AgentRunResult>((resolve) => {
        const finish = (): void => {
          resolve({
            error: "interrupted",
            mode: "waitForCompletion",
            sessionId: child.id,
            success: false,
          });
        };
        if (input.signal?.aborted) {
          finish();
        } else {
          input.signal?.addEventListener("abort", finish, { once: true });
        }
      }),
  );
  const instanceFactory: AgentInstanceFactory = {
    create(identity) {
      return {
        contextScope: {} as AgentInstance["contextScope"],
        identity,
        turn,
      };
    },
  };
  const store = new InMemorySubagentInstanceStore();
  const host = new SessionSubagentHost({
    executionStore: new InMemorySubagentExecutionStore(),
    resolveRequester: async (input) => ({
      rootRunId: input.requesterRunId,
      rootSessionId: input.parentSessionId,
    }),
    agentManager: {
      getRuntimeAgent(role): Promise<RuntimeAgent> {
        return Promise.resolve({
          config: { maxSteps: 5, mode: "subagent", name: role },
          isSubagent: true,
          systemPrompt: "system",
          tools: {},
        });
      },
    },
    createRunId: (() => {
      let next = 1;
      return () => `run_${String(next++)}`;
    })(),
    createSubagentId: (() => {
      let next = 1;
      return () => `subagent_${String(next++)}`;
    })(),
    instanceFactory,
    modelId: "fake-model",
    ownerId: "owner_current",
    ownerPid: 101,
    sessionManager: {
      create(): Promise<Session> {
        sessions.set(child.id, child);
        return Promise.resolve(child);
      },
      get(sessionId): Promise<Session | null> {
        return Promise.resolve(sessions.get(sessionId) ?? null);
      },
    },
    store,
  });
  let rootSequence = 1;
  let requestSequence = 0;
  const run = host.run.bind(host);
  host.run = (input) =>
    run({
      requesterRunId: `goal-root-${rootSequence}`,
      requesterMessageId: "goal-message",
      requestId: `request-${++requestSequence}`,
      ...input,
    });
  const goalService = new GoalService({
    executionControl: {
      async interruptGoalExecution(input): Promise<void> {
        await host.interruptByRootRun(
          `goal-root-${rootSequence}`,
          input.reason,
        );
        rootSequence += 1;
      },
    },
    persistence: new InMemoryGoalPersistence(),
    ...(options.safetyCapTurns === undefined
      ? {}
      : { safetyCapTurns: options.safetyCapTurns }),
  });
  return { goalService, host, store, turn };
}

async function waitUntilRunning(
  store: InMemorySubagentInstanceStore,
  subagentId: string,
): Promise<void> {
  await vi.waitUntil(async () => {
    const record = await store.get({
      parentSessionId: parent.id,
      subagentId,
    });
    return record?.status === "running";
  });
}

describe("goal and subagent lifecycle integration", () => {
  it("pauses active background work without closing its logical instance", async () => {
    const { goalService, host, store } = createFixture();
    try {
      await goalService.createGoal(parent.id, {
        actor: "user",
        objective: "finish long work",
      });
      const started = await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "long work",
        role: "explore",
      });
      await waitUntilRunning(store, started.execution.subagentId);
      await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "queued follow-up",
        subagentId: started.execution.subagentId,
      });

      await goalService.pauseGoal(parent.id, "paused by user");

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.execution.subagentId,
      });
      expect(record).toMatchObject({
        pendingQueue: [],
        status: "interrupted",
      });
      expect(record?.closedAt).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("interrupts a complete-time straggler without closing it", async () => {
    const { goalService, host, store } = createFixture();
    try {
      await goalService.createGoal(parent.id, {
        actor: "user",
        objective: "finish long work",
      });
      const started = await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "unexpected straggler",
        role: "explore",
      });
      await waitUntilRunning(store, started.execution.subagentId);

      await goalService.updateGoalFromModel(parent.id, "complete");

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.execution.subagentId,
      });
      expect(await goalService.getSnapshot(parent.id)).toBeNull();
      expect(record?.status).toBe("interrupted");
      expect(record?.closedAt).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("cancels an active goal while preserving its interrupted subagent instance", async () => {
    const { goalService, host, store } = createFixture();
    try {
      await goalService.createGoal(parent.id, {
        actor: "user",
        objective: "finish long work",
      });
      const started = await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "long work",
        role: "explore",
      });
      await waitUntilRunning(store, started.execution.subagentId);

      await goalService.cancelGoal(parent.id);

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.execution.subagentId,
      });
      expect(await goalService.getSnapshot(parent.id)).toBeNull();
      expect(record?.status).toBe("interrupted");
      expect(record?.closedAt).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("does not interrupt ordinary subagent work when cancelling a paused goal", async () => {
    const { goalService, host, store } = createFixture();
    try {
      await goalService.createGoal(parent.id, {
        actor: "user",
        objective: "finish long work",
      });
      await goalService.pauseGoal(parent.id);
      const ordinary = await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "ordinary paused-period work",
        role: "explore",
      });
      await waitUntilRunning(store, ordinary.execution.subagentId);

      await goalService.cancelGoal(parent.id);

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: ordinary.execution.subagentId,
      });
      expect(await goalService.getSnapshot(parent.id)).toBeNull();
      expect(record?.status).toBe("running");
    } finally {
      await host.dispose();
    }
  });

  it("does not auto-drain an interrupted subagent when the goal resumes", async () => {
    const { goalService, host, store } = createFixture();
    try {
      await goalService.createGoal(parent.id, {
        actor: "user",
        objective: "finish long work",
      });
      const started = await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "long work",
        role: "explore",
      });
      await waitUntilRunning(store, started.execution.subagentId);
      await goalService.pauseGoal(parent.id);

      await goalService.resumeGoal(parent.id);

      await expect(
        store.get({
          parentSessionId: parent.id,
          subagentId: started.execution.subagentId,
        }),
      ).resolves.toMatchObject({ status: "interrupted" });

      await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "main explicitly resumed this subagent",
        subagentId: started.execution.subagentId,
      });
      await waitUntilRunning(store, started.execution.subagentId);
    } finally {
      await host.dispose();
    }
  });

  it("interrupts background work when the runtime safety cap pauses the goal", async () => {
    const { goalService, host, store, turn } = createFixture({
      safetyCapTurns: 0,
    });
    try {
      await goalService.createGoal(parent.id, {
        actor: "user",
        objective: "finish long work",
      });
      const started = await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "long work",
        role: "explore",
      });
      await waitUntilRunning(store, started.execution.subagentId);
      await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "queued after safety pause",
        subagentId: started.execution.subagentId,
      });
      goalService.attachTurnRunner({
        runTurn() {
          return Promise.resolve({ status: "succeeded" as const });
        },
      });

      goalService.ensureDriving(parent.id);
      await goalService.whenIdle(parent.id);

      expect((await goalService.getSnapshot(parent.id))?.status).toBe("paused");
      expect(turn).toHaveBeenCalledTimes(1);
      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.execution.subagentId,
      });
      expect(record).toMatchObject({
        pendingQueue: [],
        status: "interrupted",
      });
      expect(record?.closedAt).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
