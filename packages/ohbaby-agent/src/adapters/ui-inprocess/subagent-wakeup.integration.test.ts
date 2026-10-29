import { describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { createInProcessUiBackendClient } from "../ui-inprocess.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import { createBus } from "../../bus/index.js";
import { AgentManager } from "../../agents/manager.js";
import { createInMemoryRunLedger } from "../../runtime/run-ledger/index.js";
import { InMemoryGoalPersistence } from "../../goals/index.js";
import { AgentRegistry } from "../../agents/registry.js";

function stream(
  events: InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
    for (const event of events) yield await Promise.resolve(event);
  })();
}

describe("background subagent wakeup through the main session execution gate", () => {
  it.each([
    {
      stopParent: false,
      goal: false,
      failFinalization: false,
      exhaustBudget: false,
    },
    {
      stopParent: true,
      goal: false,
      failFinalization: false,
      exhaustBudget: false,
    },
    {
      stopParent: false,
      goal: true,
      failFinalization: false,
      exhaustBudget: false,
    },
    {
      stopParent: false,
      goal: true,
      failFinalization: true,
      exhaustBudget: false,
    },
    {
      stopParent: false,
      goal: true,
      failFinalization: false,
      exhaustBudget: true,
    },
  ])(
    "delivers a child result in a later main run after the original main run ends ($stopParent Stop; $goal Goal; $failFinalization finalization failure; $exhaustBudget budget exhausted)",
    async ({ stopParent, goal, failFinalization, exhaustBudget }) => {
      let releaseChild!: () => void;
      const childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      const executions = new InMemorySubagentExecutionStore();
      const goalPersistence = new InMemoryGoalPersistence();
      const runLedger = createInMemoryRunLedger();
      const markSucceeded = runLedger.markSucceeded.bind(runLedger);
      let finalizationWritable = !failFinalization;
      runLedger.markSucceeded = (
        runId,
        result,
      ): ReturnType<typeof markSucceeded> =>
        runId === "run_3" && !finalizationWritable
          ? Promise.reject(new Error("wake finalization unavailable"))
          : markSucceeded(runId, result);
      const messages = createMessageManager({
        bus: createBus(),
        store: createInMemoryMessageStore(),
      });
      const parents: InterfaceProviderRequest[] = [];
      let childSignal: AbortSignal | undefined;
      let secondChildSignal: AbortSignal | undefined;
      let childRequests = 0;
      let secondStarted!: () => void;
      const secondChildStarted = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      const llm: LLMClientInstance<{ kind: "fake" }> = {
        config: {
          provider: "fake",
          model: "fake-model",
          apiKeyEnv: "FAKE_API_KEY",
          baseUrl: "https://example.invalid/v1",
          interfaceProvider: "openai-compatible",
          temperature: 0,
          maxTokens: 128,
          modelProfiles: [
            {
              model: "fake-model",
              contextWindowTokens: 128000,
              reasoningCapabilities: {
                mode: "effort",
                wire: "openai",
                efforts: ["low", "medium", "high"],
                supportsDisabled: true,
              },
            },
          ],
        },
        provider: {
          id: "fake",
          kind: "openai-compatible",
          client: { kind: "fake" },
          isAbortError: (error) =>
            error instanceof Error && error.name === "AbortError",
          streamResponse(request) {
            const prompt = JSON.stringify(request.messages);
            if (prompt.includes("Write a short conversation title"))
              return Promise.resolve(
                stream([{ textDelta: "Child task", finishReason: "stop" }]),
              );
            if (prompt.includes("You are a focused subagent")) {
              if (exhaustBudget && ++childRequests === 2) {
                secondChildSignal = request.signal;
                secondStarted();
                return Promise.resolve(
                  (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                    await new Promise<void>((_resolve, reject) => {
                      if (request.signal?.aborted)
                        reject(new DOMException("Stopped", "AbortError"));
                      else
                        request.signal?.addEventListener(
                          "abort",
                          () => {
                            reject(new DOMException("Stopped", "AbortError"));
                          },
                          { once: true },
                        );
                    });
                    yield { textDelta: "never", finishReason: "stop" };
                  })(),
                );
              }
              childSignal = request.signal;
              return Promise.resolve(
                (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                  await childGate;
                  yield {
                    textDelta: "CHILD-RESULT-AFTER-MAIN",
                    finishReason: "stop" as const,
                  };
                })(),
              );
            }
            parents.push(request);
            if (parents.length === 1)
              return Promise.resolve(
                stream([
                  {
                    toolCallDeltas: [
                      {
                        index: 0,
                        id: "dispatch",
                        name: "agent",
                        argumentsDelta: JSON.stringify({
                          action: "spawn",
                          prompt: "Reply with child result",
                          role: "generic",
                          mode: "background",
                        }),
                      },
                      ...(exhaustBudget
                        ? [
                            {
                              index: 1,
                              id: "budget",
                              name: "SetGoalBudget",
                              argumentsDelta: JSON.stringify({
                                unit: "turns",
                                value: 2,
                              }),
                            },
                          ]
                        : []),
                    ],
                    finishReason: "tool_calls",
                  },
                ]),
              );
            if (parents.length === 2 && stopParent)
              return Promise.resolve(
                (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                  await new Promise<void>((_resolve, reject) => {
                    if (request.signal?.aborted) {
                      reject(new DOMException("Stopped", "AbortError"));
                      return;
                    }
                    request.signal?.addEventListener(
                      "abort",
                      () => {
                        reject(new DOMException("Stopped", "AbortError"));
                      },
                      { once: true },
                    );
                  });
                  yield {
                    textDelta: "unreachable",
                    finishReason: "stop" as const,
                  };
                })(),
              );
            if (goal && !failFinalization && parents.length === 3)
              return Promise.resolve(
                stream([
                  {
                    toolCallDeltas: [
                      {
                        index: 0,
                        id: "finish-goal",
                        name: exhaustBudget ? "agent" : "UpdateGoal",
                        argumentsDelta: JSON.stringify(
                          exhaustBudget
                            ? {
                                action: "spawn",
                                prompt: "Continue independent background work",
                                mode: "background",
                                role: "generic",
                              }
                            : { status: "complete" },
                        ),
                      },
                    ],
                    finishReason: "tool_calls",
                  },
                ]),
              );
            return (
              exhaustBudget && parents.length === 4
                ? secondChildStarted
                : Promise.resolve()
            ).then(() =>
              stream([
                {
                  tokenUsage: {
                    inputTokens: 8,
                    outputTokens: 2,
                    totalTokens: 10,
                  },
                  textDelta:
                    parents.length === 2
                      ? "Started background work"
                      : "Handled child result",
                  finishReason: "stop",
                },
              ]),
            );
          },
        },
      };
      const client = createInProcessUiBackendClient({
        llmClient: llm,
        goalPersistence,
        runLedger,
        messageManager: messages,
        subagentExecutionStore: executions,
        agentManager: new AgentManager({
          registry: new AgentRegistry({
            configLoader: (): { agents: Record<string, never> } => ({
              agents: {},
            }),
            builtinAgents: [
              {
                name: "main",
                description: "Main",
                mode: "primary",
                default: true,
                tools: { include: ["agent", "UpdateGoal", "SetGoalBudget"] },
              },
              {
                name: "generic",
                description: "Child",
                mode: "subagent",
                tools: { include: [] },
              },
            ],
          }),
        }),
      });
      try {
        if (goal) {
          await client.createSession();
          await client.updateSessionReasoning({
            sessionId: "session_1",
            reasoning: { enabled: true, effort: "high" },
          });
        }
        const original = goal
          ? client.executeCommand({
              argv: ["Run an independent child"],
              clientInvocationId: "start-goal",
              commandId: "goal",
              path: ["goal"],
              raw: "/goal Run an independent child",
              rawArgs: "Run an independent child",
              sessionId: "session_1",
              surface: "tui",
            })
          : client.submitPromptAndWait("Run an independent child", {
              reasoning: { enabled: true, effort: "high" },
            });
        void original.catch(() => undefined);
        await vi.waitFor(() => {
          expect(parents).toHaveLength(2);
          expect(childSignal).toBeDefined();
        });
        if (stopParent) {
          const snapshot = await client.getSnapshot();
          const run = snapshot.runs.find(
            (run) =>
              run.sessionId === "session_1" && run.status.kind === "running",
          );
          if (!run) throw new Error("Missing active main run");
          await client.abortRun(run.id);
        }
        await original;
        if (goal)
          await vi.waitFor(() => {
            expect(
              client.getActiveGoalRunForSteer("session_1"),
            ).toBeUndefined();
          });
        expect(childSignal?.aborted).toBe(false);
        expect(parents).toHaveLength(2);
        expect(
          await executions.list({ rootSessionId: "session_1" }),
        ).toMatchObject([{ status: "running" }]);
        releaseChild();
        await vi.waitFor(async () => {
          expect(parents).toHaveLength(goal && !failFinalization ? 4 : 3);
          const records = await executions.list({ rootSessionId: "session_1" });
          expect(
            records.find(
              (record) => record.output === "CHILD-RESULT-AFTER-MAIN",
            ),
          ).toMatchObject({
            status: "completed",
            delivery: { state: "processed" },
          });
        });
        expect(parents[2]?.reasoning).toMatchObject({ effort: "high" });
        if (exhaustBudget) {
          await vi.waitFor(async () => {
            const snapshot = await client.getSnapshot();
            expect(
              snapshot.goals?.find((g) => g.sessionId === "session_1")?.goal,
            ).toMatchObject({ status: "blocked", turnsUsed: 2 });
            expect(secondChildSignal?.aborted).toBe(true);
            expect(
              await executions.list({ rootSessionId: "session_1" }),
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ status: "interrupted" }),
              ]),
            );
          });
          expect(parents).toHaveLength(4);
        } else if (failFinalization) {
          await vi.waitFor(async () => {
            expect(
              (await client.getSessionControl({ sessionId: "session_1" }))
                .executionRecovery?.status,
            ).toBe("blocked");
            expect(
              (await client.getSnapshot()).goals?.find(
                (g) => g.sessionId === "session_1",
              )?.goal.status,
            ).toBe("paused");
          });
          finalizationWritable = true;
          await client.initializeSession("session_1");
          expect(client.getActiveGoalRunForSteer("session_1")).toBeUndefined();
          expect(parents).toHaveLength(3);
        } else if (goal) {
          await vi.waitFor(async () => {
            expect((await goalPersistence.list("session_1")).at(-1)?.type).toBe(
              "clear",
            );
          });
          const records = await goalPersistence.list("session_1");
          expect(Math.max(...records.map((r) => r.turnsUsed ?? 0))).toBe(2);
          expect(Math.max(...records.map((r) => r.tokensUsed ?? 0))).toBe(20);
        }
        expect(JSON.stringify(parents[2]?.messages)).toContain(
          "CHILD-RESULT-AFTER-MAIN",
        );
        const saved = await messages.listBySession("session_1");
        expect(
          saved.filter(
            (message) =>
              message.info.role === "user" &&
              message.info.contextScopeId === undefined &&
              !message.info.runtimeInput &&
              message.parts.some(
                (part) => part.type === "text" && !part.synthetic,
              ),
          ),
        ).toHaveLength(1);
        expect(
          saved.some(
            (message) => message.info.runtimeInput?.kind === "subagent-status",
          ),
        ).toBe(true);
        const childRecord = (
          await executions.list({ rootSessionId: "session_1" })
        ).find((record) => record.output === "CHILD-RESULT-AFTER-MAIN");
        const resultMessage = saved.find(
          (message) => message.info.runtimeInput?.kind === "subagent-result",
        );
        expect(resultMessage?.info.runId).not.toBe(childRecord?.rootRunId);
      } finally {
        finalizationWritable = true;
        releaseChild();
        await client.dispose();
      }
    },
  );
});
