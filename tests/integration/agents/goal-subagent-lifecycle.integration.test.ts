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
  const goalService = new GoalService({
    executionControl: {
      async interruptGoalExecution(input): Promise<void> {
        await host.interruptByParent(input.sessionId, input.reason);
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
      await waitUntilRunning(store, started.item.subagentId);
      await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "queued follow-up",
        subagentId: started.item.subagentId,
      });

      await goalService.pauseGoal(parent.id, "paused by user");

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.item.subagentId,
      });
      expect(record).toMatchObject({
        pendingQueue: [{ prompt: "queued follow-up" }],
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
      await waitUntilRunning(store, started.item.subagentId);

      await goalService.updateGoalFromModel(parent.id, "complete");

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.item.subagentId,
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
      await waitUntilRunning(store, started.item.subagentId);

      await goalService.cancelGoal(parent.id);

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: started.item.subagentId,
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
      await waitUntilRunning(store, ordinary.item.subagentId);

      await goalService.cancelGoal(parent.id);

      const record = await store.get({
        parentSessionId: parent.id,
        subagentId: ordinary.item.subagentId,
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
      await waitUntilRunning(store, started.item.subagentId);
      await goalService.pauseGoal(parent.id);

      await goalService.resumeGoal(parent.id);

      await expect(
        store.get({
          parentSessionId: parent.id,
          subagentId: started.item.subagentId,
        }),
      ).resolves.toMatchObject({ status: "interrupted" });

      await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "main explicitly resumed this subagent",
        subagentId: started.item.subagentId,
      });
      await waitUntilRunning(store, started.item.subagentId);
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
      await waitUntilRunning(store, started.item.subagentId);
      await host.run({
        mode: "background",
        parentSessionId: parent.id,
        prompt: "queued after safety pause",
        subagentId: started.item.subagentId,
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
        subagentId: started.item.subagentId,
      });
      expect(record).toMatchObject({
        pendingQueue: [{ prompt: "queued after safety pause" }],
        status: "interrupted",
      });
      expect(record?.closedAt).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
