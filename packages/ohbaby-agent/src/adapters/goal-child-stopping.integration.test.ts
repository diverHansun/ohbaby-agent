import { afterEach, expect, it, vi } from "vitest";
import type { AgentInstance, AgentRunResult } from "../core/agents/index.js";
import {
  InMemorySubagentExecutionStore,
  InMemorySubagentInstanceStore,
  type RuntimeAgent,
} from "../agents/index.js";
import { SessionSubagentHost } from "../agents/subagent-host.js";
import {
  GoalService,
  GoalStore,
  InMemoryGoalPersistence,
} from "../goals/index.js";
import type { GoalMutationContext, GoalTurnTicket } from "../goals/index.js";
import type { Session } from "../services/session/index.js";
import { executeGoalExecutionInterrupt } from "./goal-execution-control.js";

afterEach(() => vi.useRealTimers());

it.each([
  "deadline",
  "objective-deadline",
  "model-blocked",
  "waiting-for-user",
] as const)(
  "%s stops only the goal execution selected by the real lifecycle",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(0);
    const parent: Session = {
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
    const child: Session = {
      ...parent,
      id: "child",
      isSubagent: true,
      parentId: parent.id,
    };
    const instances = new InMemorySubagentInstanceStore();
    const executions = new InMemorySubagentExecutionStore();
    const signals = new Map<string, AbortSignal>();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let ids = 0;
    const host = new SessionSubagentHost({
      store: instances,
      executionStore: executions,
      modelId: "fake",
      agentManager: {
        getRuntimeAgent: (role): Promise<RuntimeAgent> =>
          Promise.resolve({
            config: { mode: "subagent", name: role ?? "explore", maxSteps: 5 },
            isSubagent: true,
            tools: {},
          }),
      },
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
          contextScope: {} as AgentInstance["contextScope"],
          turn: (input): Promise<AgentRunResult> =>
            new Promise((resolve) => {
              if (input.signal === undefined)
                throw new Error("Missing host execution abort signal");
              signals.set(input.prompt, input.signal);
              if (signals.size === 2) notifyStarted();
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
    const owner = scenario === "waiting-for-user" ? "user" : "goal";
    const persistence = new InMemoryGoalPersistence();
    const service: GoalService = new GoalService({
      persistence,
      resolveMutationContext: (sessionId, runId): GoalMutationContext => {
        const ticket = service.getTicketForRun(sessionId, runId);
        return ticket === undefined
          ? { kind: "invalid" }
          : { kind: "goal", ticket };
      },
      executionControl: {
        interruptGoalExecution: (input): Promise<void> =>
          executeGoalExecutionInterrupt(input, {
            activeRunId: (): string =>
              owner === "goal" ? "goal-root" : "user-root",
            promptOwner: (): "goal" | "user" => owner,
            promptSessionId: (): string => parent.id,
            // Child-only interruption must finish even while the primary handshake is pending.
            waitForPromptRunReadyOrIdle: (): Promise<void> =>
              scenario === "model-blocked"
                ? new Promise<void>(() => undefined)
                : Promise.resolve(),
            abortPromptRun: async (runId): Promise<boolean> => {
              (runId === "goal-root" ? goalPrimary : userPrimary).abort();
              await host.interruptByRootRun(runId, "primary stopped");
              return true;
            },
            interruptSubagentsByRootRun: async (
              runId,
              reason,
            ): Promise<void> => {
              await host.interruptByRootRun(runId, reason);
            },
          }),
      },
    });
    try {
      const goal = await service.createGoal(parent.id, {
        actor: "user",
        objective: "finish the task",
        ...(scenario === "model-blocked"
          ? {}
          : { budgetLimits: { wallClockBudgetMs: 1000 } }),
      });
      let current: GoalTurnTicket | undefined;
      if (scenario !== "waiting-for-user") {
        for (
          let turn = 1;
          turn <= (scenario === "model-blocked" ? 3 : 1);
          turn++
        ) {
          const ticket = await service.admitTurnInBoundary(
            parent.id,
            goal.goalId,
            service.currentExecutionEpoch(parent.id),
          );
          if (ticket === null) throw new Error("Expected admitted goal turn");
          service.bindTicketRun(
            ticket,
            scenario === "model-blocked" && turn < 3
              ? `previous-${String(turn)}`
              : "goal-root",
          );
          if (scenario === "model-blocked" && turn < 3) {
            const report = await service.updateGoalFromModel(
              parent.id,
              "blocked",
              "waiting for access",
              ticket.runId,
            );
            expect(report.note).toContain(`${String(turn)}/3`);
            expect(report.snapshot?.status).toBe("active");
            await service.settleTurn(parent.id, ticket, {
              status: "succeeded",
              usage: { usageComplete: true },
            });
          } else current = ticket;
        }
      }
      const goalChild = await host.run({
        parentSessionId: parent.id,
        requesterRunId: "goal-root",
        requesterMessageId: "g",
        requestId: "goal-child",
        prompt: "goal child",
        role: "explore",
        mode: "background",
      });
      const userChild = await host.run({
        parentSessionId: parent.id,
        requesterRunId: "user-root",
        requesterMessageId: "u",
        requestId: "user-child",
        prompt: "user child",
        role: "explore",
        mode: "background",
      });
      await started;
      expect(signals.get("goal child")?.aborted).toBe(false);
      expect(signals.get("user child")?.aborted).toBe(false);
      if (scenario === "model-blocked") {
        await service.updateGoalFromModel(
          parent.id,
          "blocked",
          "waiting for access",
          current?.runId,
        );
      } else if (scenario === "objective-deadline") {
        await vi.advanceTimersByTimeAsync(400);
        const oldEpoch = current?.executionEpoch;
        await service.replaceGoal(parent.id, "finish the revised task");
        expect(service.currentExecutionEpoch(parent.id)).not.toBe(oldEpoch);
        expect(service.peekSnapshot(parent.id)).toMatchObject({
          goalId: goal.goalId,
          turnsUsed: 1,
          wallClockMs: 400,
        });
        expect(goalPrimary.signal.aborted).toBe(false);
        expect(signals.get("goal child")?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(599);
        expect(service.peekSnapshot(parent.id)?.status).toBe("active");
        expect(signals.get("goal child")?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(service.peekSnapshot(parent.id)?.wallClockMs).toBe(1000);
      } else await vi.advanceTimersByTimeAsync(1000);

      expect(service.peekSnapshot(parent.id)).toMatchObject({
        status: "blocked",
        turnsUsed:
          scenario === "model-blocked"
            ? 3
            : scenario === "waiting-for-user"
              ? 0
              : 1,
      });
      expect(goalPrimary.signal.aborted).toBe(
        scenario === "deadline" || scenario === "objective-deadline",
      );
      expect(userPrimary.signal.aborted).toBe(false);
      expect(signals.get("goal child")?.aborted).toBe(
        scenario !== "waiting-for-user",
      );
      expect(signals.get("user child")?.aborted).toBe(false);
      const goalStatus =
        scenario === "waiting-for-user" ? "running" : "interrupted";
      expect(
        await instances.get({
          parentSessionId: parent.id,
          subagentId: goalChild.execution.subagentId,
        }),
      ).toMatchObject({ status: goalStatus });
      expect(
        await executions.get({
          parentSessionId: parent.id,
          executionId: goalChild.execution.executionId,
        }),
      ).toMatchObject({ status: goalStatus });
      expect(
        await instances.get({
          parentSessionId: parent.id,
          subagentId: userChild.execution.subagentId,
        }),
      ).toMatchObject({ status: "running" });
      expect(
        await executions.get({
          parentSessionId: parent.id,
          executionId: userChild.execution.executionId,
        }),
      ).toMatchObject({ status: "running" });
      const rebuilt = await GoalStore.rebuild({
        persistence,
        sessionId: parent.id,
      });
      expect(rebuilt.getSnapshot()?.status).toBe("blocked");
      if (scenario === "model-blocked" && current !== undefined) {
        await service.settleTurn(parent.id, current, {
          status: "succeeded",
          usage: { usageComplete: true },
        });
        expect(goalPrimary.signal.aborted).toBe(false);
        expect(service.peekSnapshot(parent.id)?.status).toBe("blocked");
      }
    } finally {
      service.dispose();
      await host.dispose();
    }
  },
);
