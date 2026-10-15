/** HTTP daemon + SQLite + production goal tools/runtime. Set
 * OHBABY_RUN_GOAL_REAL_E2E=1 for the paid DeepSeek case (DEEPSEEK_API_KEY in .env).
 * Kept beside model-idle.e2e.test.ts so both use the existing E2E runner.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import {
  createPersistentUiBackendClient,
  closePersistentUiBackendDatabase,
} from "../../../../ohbaby-agent/src/adapters/ui-persistent.js";
import { loadEnvFile } from "../../../../ohbaby-agent/src/config/llm/loaders.js";
import type { LLMClientInstance } from "../../../../ohbaby-agent/src/core/llm-client/types.js";
import { createSqliteGoalPersistence } from "../../../../ohbaby-agent/src/goals/persistence.js";
import type { GoalPersistencePort } from "../../../../ohbaby-agent/src/goals/types.js";
import { getDatabase } from "../../../../ohbaby-agent/src/services/database/index.js";
import { createInterfaceProvider } from "../../../../ohbaby-agent/src/services/interface-providers/index.js";
import type {
  InterfaceProviderStreamEvent,
  InterfaceProviderTokenUsage,
} from "../../../../ohbaby-agent/src/services/interface-providers/types.js";
import { createRemoteUiBackendClient } from "../../protocols/jsonrpc/client.js";
import { createDaemonHttpServer } from "./server.js";

type RemoteClient = ReturnType<typeof createRemoteUiBackendClient>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withDaemon(
  llmClient: LLMClientInstance,
  check: (fixture: {
    client: RemoteClient;
    events: UiEvent[];
    persistence: GoalPersistencePort;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(os.tmpdir(), "ohbaby-goal-e2e-"));
  const home = join(root, "home");
  const workdir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workdir);
  await writeFile(join(home, ".skip-auto-migrate"), "");
  vi.stubEnv("OHBABY_HOME", home);
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const backend = createPersistentUiBackendClient({
    dbPath: join(root, "session.db"),
    workdir,
    projectDirectory: workdir,
    llmClient,
    enableSnapshots: false,
  });
  const authToken = randomUUID();
  const connected = deferred();
  const server = createDaemonHttpServer({
    backend,
    authToken,
    host: "127.0.0.1",
    port: 0,
    onClientConnected: connected.resolve,
  });
  let client: RemoteClient | undefined;
  try {
    await server.start();
    client = createRemoteUiBackendClient({
      authToken,
      host: "127.0.0.1",
      port: server.port,
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => events.push(event));
    await connected.promise;
    await check({
      client,
      events,
      persistence: createSqliteGoalPersistence(getDatabase()),
    });
  } finally {
    await client?.dispose();
    await server.stop();
    await backend.dispose();
    closePersistentUiBackendDatabase();
    await rm(root, { recursive: true, force: true });
  }
}

async function createGoal(
  client: RemoteClient,
  sessionId: string,
  objective: string,
): Promise<void> {
  const result = await client.executeCommand({
    commandId: "goal",
    path: ["goal"],
    clientInvocationId: randomUUID(),
    raw: `/goal ${objective}`,
    rawArgs: objective,
    argv: [objective],
    sessionId,
    surface: "web",
  });
  expect(result.status).toBe("completed");
}

function completionNotices(events: readonly UiEvent[]): UiEvent[] {
  return events.filter(
    (event) =>
      event.type === "notice.emitted" &&
      event.notice.source === "goals" &&
      event.notice.message === "Goal completed.",
  );
}

function usage(total: number, cached: number): InterfaceProviderTokenUsage {
  return {
    inputTokens: total - 10,
    outputTokens: 10,
    totalTokens: total,
    inputBreakdown: {
      uncached: total - 10 - cached,
      cacheRead: cached,
      cacheWrite: 0,
      observed: { cacheRead: true, cacheWrite: true },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("goal execution through the HTTP daemon", () => {
  it("keeps oversized protected input recoverable when context preparation rejects it before the next request", async () => {
    const started = deferred();
    const nextStep = deferred();
    const text = Array.from(
      { length: 25_000 },
      (_, index) => `UNIQUE_INPUT_${String(index)}`,
    ).join(" ");
    let ordinaryRequests = 0;
    const llmClient: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        maxTokens: 128,
        contextWindowTokens: 32000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (request.purpose === "session-title") {
                yield {
                  textDelta: "Oversized input fixture",
                  finishReason: "stop",
                };
                return;
              }
              if (request.purpose === "context-summary") {
                yield {
                  textDelta:
                    "The goal is testing oversized protected input recovery.",
                  finishReason: "stop",
                  tokenUsage: usage(100, 0),
                };
                return;
              }
              ordinaryRequests++;
              expect(ordinaryRequests).toBe(1);
              started.resolve();
              await nextStep.promise;
              yield {
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "read_goal_before_overflow",
                    name: "GetGoal",
                    argumentsDelta: "{}",
                  },
                ],
                finishReason: "tool_calls",
                tokenUsage: usage(100, 0),
              };
            })(),
          );
        },
      },
    };
    await withDaemon(llmClient, async ({ client }) => {
      try {
        const session = await client.createSession();
        await createGoal(
          client,
          session.id,
          "Exercise oversized protected input",
        );
        await started.promise;
        const original = await client.submitPromptAccepted(text, {
          sessionId: session.id,
        });
        expect(original.status).toBe("steered");
        nextStep.resolve();
        await vi.waitFor(
          async () => {
            const view = await client.getSessionView({ sessionId: session.id });
            expect(
              view.runs.some(
                (run) =>
                  run.status.kind === "error" &&
                  /context|input.*budget|compact/i.test(run.status.message),
              ),
            ).toBe(true);
            expect(view.session.unconsumedSteers).toEqual([
              expect.objectContaining({
                promptId: original.promptId,
                text,
                state: "unconsumed",
              }),
            ]);
          },
          { timeout: 10_000 },
        );
        expect(ordinaryRequests).toBe(1);
        const view = await client.getSessionView({ sessionId: session.id });
        const recovery = view.session.unconsumedSteers?.[0];
        if (!recovery) throw new Error("Expected oversized input recovery");
        const resent = await client.resendSteerInput({
          inputId: recovery.inputId,
          operationId: "oversized-explicit-resend",
        });
        expect(resent.promptId).not.toBe(original.promptId);
        expect(resent.userMessageId).not.toBe(original.userMessageId);
        const completion = await client.waitForPrompt(resent.promptId, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(completion.prompt.status).toBe("failed");
        await vi.waitFor(async () => {
          expect(
            (
              await client.getSessionView({ sessionId: session.id })
            ).session.unconsumedSteers?.some(
              (input) =>
                input.promptId === original.promptId && input.text === text,
            ),
          ).toBe(true);
        });
        expect(ordinaryRequests).toBe(1);
      } finally {
        nextStep.resolve();
      }
    });
  }, 25_000);

  it("publishes failed-run input recovery over SSE and resends through a fresh idempotent HTTP prompt", async () => {
    const started = deferred();
    const failGoal = deferred();
    const resendStarted = deferred();
    const finishResend = deferred();
    let requests = 0;
    const text = "RECOVER_THIS_STEER";
    const llmClient: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        maxTokens: 128,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (request.purpose === "session-title") {
                yield { textDelta: "Recovery fixture", finishReason: "stop" };
                return;
              }
              const index = requests++;
              if (index === 0) {
                started.resolve();
                yield { textDelta: "Partial output before a provider failure" };
                await failGoal.promise;
                throw new Error("Controlled provider failure after output");
              }
              expect(index).toBe(1);
              expect(JSON.stringify(request.messages)).toContain(text);
              resendStarted.resolve();
              await finishResend.promise;
              yield {
                textDelta: "RESEND_OK",
                finishReason: "stop",
                tokenUsage: usage(100, 0),
              };
            })(),
          );
        },
      },
    };
    await withDaemon(llmClient, async ({ client, events }) => {
      try {
        const session = await client.createSession();
        await createGoal(
          client,
          session.id,
          "Exercise failed-run input recovery",
        );
        await started.promise;
        const original = await client.submitPromptAccepted(text, {
          sessionId: session.id,
        });
        expect(original.status).toBe("steered");
        failGoal.resolve();
        await vi.waitFor(async () => {
          const view = await client.getSessionView({ sessionId: session.id });
          expect(view.session.unconsumedSteers).toEqual([
            expect.objectContaining({
              promptId: original.promptId,
              messageId: original.userMessageId,
              text,
              state: "unconsumed",
            }),
          ]);
          expect(view.runs.some((run) => run.status.kind === "error")).toBe(
            true,
          );
        });
        const view = await client.getSessionView({ sessionId: session.id });
        const recovery = view.session.unconsumedSteers?.[0];
        if (!recovery) throw new Error("Expected failed-run input recovery");
        const inputId = recovery.inputId;
        await vi.waitFor(() => {
          expect(
            events.some(
              (event) =>
                event.type === "session.updated" &&
                event.session.unconsumedSteers?.some(
                  (input) => input.inputId === inputId,
                ),
            ),
          ).toBe(true);
        });
        const command = { inputId, operationId: "resend-http-recovery" };
        const resend = await client.resendSteerInput(command);
        expect(resend.promptId).not.toBe(original.promptId);
        expect(resend.userMessageId).not.toBe(original.userMessageId);
        await resendStarted.promise;
        const retry = await client.resendSteerInput(command);
        expect(retry.promptId).toBe(resend.promptId);
        expect(retry.userMessageId).toBe(resend.userMessageId);
        await vi.waitFor(async () => {
          expect(
            (await client.getSessionView({ sessionId: session.id })).session
              .unconsumedSteers ?? [],
          ).toEqual([]);
        });
        finishResend.resolve();
        expect(
          (
            await client.waitForPrompt(resend.promptId, {
              signal: AbortSignal.timeout(5_000),
            })
          ).prompt.status,
        ).toBe("succeeded");
        const final = await client.getSessionView({ sessionId: session.id });
        expect(final.session.unconsumedSteers ?? []).toEqual([]);
        expect(
          final.session.messages.some(
            (message) => message.id === original.userMessageId,
          ),
        ).toBe(true);
        expect(
          final.session.messages.some(
            (message) => message.id === resend.userMessageId,
          ),
        ).toBe(true);
        expect(requests).toBe(2);
      } finally {
        failGoal.resolve();
        finishResend.resolve();
      }
    });
  }, 20_000);

  it("counts blocked reports by admitted run, preserves the final reply, and atomically resumes with fresh audit", async () => {
    let requests = 0;
    const signals: AbortSignal[] = [];
    const llmClient: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        maxTokens: 128,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              await Promise.resolve();
              if (request.purpose === "session-title") {
                yield { textDelta: "Blocked fixture", finishReason: "stop" };
                return;
              }
              const step = requests++;
              if (request.signal) signals.push(request.signal);
              if (step % 2 === 0) {
                // Three reports in one admitted run must still count as only 1/3.
                yield {
                  toolCallDeltas: Array.from(
                    { length: step === 0 ? 3 : 1 },
                    (_, index) => ({
                      index,
                      id: `blocked_${String(step)}_${String(index)}`,
                      name: "UpdateGoal",
                      argumentsDelta: JSON.stringify(
                        step >= 8
                          ? { status: "complete" }
                          : {
                              status: "blocked",
                              reason: "Need the user's database choice",
                            },
                      ),
                    }),
                  ),
                  finishReason: "tool_calls",
                  tokenUsage: usage(100, 80),
                };
              } else
                yield {
                  textDelta: `TAIL_${String(step)}`,
                  finishReason: "stop",
                  tokenUsage: usage(50, 20),
                };
            })(),
          );
        },
      },
    };
    await withDaemon(llmClient, async ({ client, events, persistence }) => {
      const session = await client.createSession();
      await createGoal(client, session.id, "Resolve the database choice");
      await vi.waitFor(async () => {
        expect(
          (await persistence.list(session.id)).filter(
            (row) => row.tokensUsed !== undefined,
          ),
        ).toHaveLength(3);
      });
      const stopped = await persistence.list(session.id);
      expect(
        stopped
          .filter((row) => row.turnsUsed !== undefined)
          .map((row) => row.turnsUsed),
      ).toEqual([1, 2, 3]);
      expect(stopped.filter((row) => row.status === "blocked")).toHaveLength(1);
      expect(requests).toBe(6);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(
        (await client.getSessionView({ sessionId: session.id })).goal,
      ).toMatchObject({
        status: "ready",
        value: {
          status: "blocked",
          pauseReason: "Need the user's database choice",
        },
      });
      expect(
        JSON.stringify(
          (await client.getSessionView({ sessionId: session.id })).session
            .messages,
        ),
      ).toContain("TAIL_5");
      const resume = await client.executeCommand({
        commandId: "goal",
        path: ["goal"],
        clientInvocationId: randomUUID(),
        raw: "/goal resume 5 turns 1h",
        rawArgs: "resume 5 turns 1h",
        argv: ["resume", "5", "turns", "1h"],
        sessionId: session.id,
        surface: "web",
      });
      expect(resume.status).toBe("completed");
      await vi.waitFor(async () => {
        expect((await persistence.list(session.id)).at(-1)?.type).toBe("clear");
      });
      const records = await persistence.list(session.id);
      expect(records.filter((row) => row.status === "blocked")).toHaveLength(1);
      expect(records.filter((row) => row.status === "active")).toContainEqual(
        expect.objectContaining({
          budgetLimits: { turnBudget: 5, wallClockBudgetMs: 3_600_000 },
        }),
      );
      expect(
        records
          .filter((row) => row.turnsUsed !== undefined)
          .map((row) => row.turnsUsed),
      ).toEqual([1, 2, 3, 4, 5]);
      expect(completionNotices(events)).toHaveLength(1);
      expect((await client.getSnapshot()).goals ?? []).toEqual([]);
    });
  }, 20_000);

  it("steers into the active goal over HTTP, then queues after completion without losing tail settlement", async () => {
    const started = deferred();
    const complete = deferred();
    const tailStarted = deferred();
    const finishTail = deferred();
    const order: string[] = [];
    let goalSignal: AbortSignal | undefined;
    const llmClient: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        maxTokens: 128,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (request.purpose === "session-title") {
                yield { textDelta: "Goal fixture", finishReason: "stop" };
                return;
              }
              const index = order.length;
              order.push(["goal", "tail", "user"][index] ?? "unexpected");
              if (index === 0) {
                goalSignal = request.signal;
                started.resolve();
                await complete.promise;
                yield {
                  toolCallDeltas: [
                    {
                      index: 0,
                      id: "complete_goal",
                      name: "UpdateGoal",
                      argumentsDelta: JSON.stringify({ status: "complete" }),
                    },
                  ],
                  finishReason: "tool_calls",
                  tokenUsage: usage(100, 80),
                };
              } else if (index === 1) {
                expect(JSON.stringify(request.messages)).toContain(
                  "steered user instruction",
                );
                tailStarted.resolve();
                await finishTail.promise;
                yield {
                  textDelta: "GOAL_TAIL_OK",
                  finishReason: "stop",
                  tokenUsage: usage(50, 20),
                };
              } else {
                expect(index).toBe(2);
                expect(JSON.stringify(request.messages)).toContain(
                  "queued user",
                );
                yield {
                  textDelta: "QUEUED_USER_OK",
                  finishReason: "stop",
                  tokenUsage: usage(1000, 600),
                };
              }
            })(),
          );
        },
      },
    };

    await withDaemon(llmClient, async ({ client, events, persistence }) => {
      try {
        const session = await client.createSession();
        await createGoal(
          client,
          session.id,
          "Finish the deterministic goal fixture",
        );
        await started.promise;
        const steered = await client.submitPromptAccepted(
          "steered user instruction",
          {
            sessionId: session.id,
            clientRequestId: "auto-steer-http",
          },
        );
        expect(steered.status).toBe("steered");
        expect(steered.steer?.status).toBe("steered");
        const retry = await client.submitPromptAccepted(
          "steered user instruction",
          {
            sessionId: session.id,
            clientRequestId: "auto-steer-http",
          },
        );
        expect(retry).toEqual(steered);
        expect(
          (
            await client.waitForPrompt(steered.promptId, {
              signal: AbortSignal.timeout(5_000),
            })
          ).prompt.status,
        ).toBe("steered");
        const pending = await client.getSessionView({ sessionId: session.id });
        expect(
          pending.prompts.some(
            (row) =>
              row.promptId === steered.promptId && row.status === "queued",
          ),
        ).toBe(false);
        await vi.waitFor(() => {
          expect(
            events.some(
              (event) =>
                event.type === "prompt.updated" &&
                event.prompt.promptId === steered.promptId &&
                event.prompt.status === "steered",
            ),
          ).toBe(true);
        });
        expect(goalSignal?.aborted).toBe(false);
        expect(order).toEqual(["goal"]);
        expect(
          (await persistence.list(session.id))
            .filter((row) => row.turnsUsed !== undefined)
            .map((row) => row.turnsUsed),
        ).toEqual([1]);

        complete.resolve();
        await tailStarted.promise;
        const queued = await client.submitPromptAccepted("queued user", {
          sessionId: session.id,
        });
        expect(queued.status).toBe("queued");
        expect(queued.steer).toEqual({
          status: "not-steered",
          reason: "no-goal-run",
        });
        expect((await client.getSnapshot()).goals ?? []).toEqual([]);
        expect(
          (await client.getSessionView({ sessionId: session.id })).goal,
        ).toEqual({ status: "ready", value: null });
        const beforeTail = await persistence.list(session.id);
        expect(beforeTail.at(-1)?.status).toBe("complete");
        expect(beforeTail.some((row) => row.type === "clear")).toBe(false);
        expect(order).toEqual(["goal", "tail"]);
        expect(goalSignal?.aborted).toBe(false);
        await vi.waitFor(() => {
          expect(completionNotices(events)).toHaveLength(1);
        });

        finishTail.resolve();
        const result = await client.waitForPrompt(queued.promptId, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(result.prompt.status).toBe("succeeded");
        const records = await persistence.list(session.id);
        expect(
          records
            .filter((row) => row.turnsUsed !== undefined)
            .map((row) => row.turnsUsed),
        ).toEqual([1]);
        expect(
          records.filter((row) => row.tokensUsed !== undefined),
        ).toHaveLength(1);
        expect(
          records.find((row) => row.tokensUsed !== undefined),
        ).toMatchObject({
          tokensUsed: 150,
          cachedTokensUsed: 100,
          usageIncomplete: false,
        });
        expect(records.at(-1)?.type).toBe("clear");
        expect(records.filter((row) => row.type === "clear")).toHaveLength(1);
        expect(
          records.findIndex((row) => row.status === "complete"),
        ).toBeLessThan(
          records.findIndex((row) => row.tokensUsed !== undefined),
        );
        expect(order).toEqual(["goal", "tail", "user"]);
        expect(completionNotices(events)).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === "notice.emitted" &&
              event.notice.source === "goals",
          ),
        ).toHaveLength(2);
        const view = await client.getSessionView({ sessionId: session.id });
        expect(view.session.unconsumedSteers ?? []).toEqual([]);
        expect(
          view.session.messages.filter(
            (message) => message.id === steered.userMessageId,
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(view.session.messages)).toContain("GOAL_TAIL_OK");
        expect(JSON.stringify(view.session.messages)).toContain(
          "QUEUED_USER_OK",
        );
      } finally {
        complete.resolve();
        finishTail.resolve();
      }
    });
  }, 20_000);
});

const live = process.env.OHBABY_RUN_GOAL_REAL_E2E === "1" ? it : it.skip;
describe("live goal execution through the HTTP daemon", () => {
  live(
    "uses real DeepSeek to consume an automatic steer in the same goal run and complete it",
    async () => {
      const env = await loadEnvFile(join(process.cwd(), ".env"));
      const apiKey = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY;
      if (!apiKey)
        throw new Error("DEEPSEEK_API_KEY is required for this opt-in test");
      // Profile is documented in tests/models-4-tests.md; never log requests or keys.
      const provider = createInterfaceProvider({
        id: "deepseek",
        interfaceProvider: "openai-compatible",
        apiKey,
        baseUrl: "https://api.deepseek.com",
      });
      const open = provider.streamResponse.bind(provider);
      const firstGoalRequest = deferred();
      const allowFirstRequest = deferred();
      let calls = 0;
      let goalCalls = 0;
      provider.streamResponse = async (request): ReturnType<typeof open> => {
        if (calls >= 8) throw new Error("Real goal E2E request cap reached");
        calls++;
        if (request.purpose !== "session-title") {
          goalCalls++;
          if (goalCalls === 1) {
            firstGoalRequest.resolve();
            await allowFirstRequest.promise;
          }
        }
        return open({
          ...request,
          signal: AbortSignal.any([
            ...(request.signal ? [request.signal] : []),
            AbortSignal.timeout(60_000),
          ]),
        });
      };
      const marker = `GOAL_LIVE_${randomUUID().replaceAll("-", "")}`;
      await withDaemon(
        {
          provider,
          config: {
            provider: "deepseek",
            model: "deepseek-flash",
            interfaceProvider: "openai-compatible",
            baseUrl: "https://api.deepseek.com",
            maxTokens: 2048,
            contextWindowTokens: 128000,
            reasoning: { enabled: false },
            modelProfiles: [
              {
                model: "deepseek-flash",
                contextWindowTokens: 128000,
                reasoningCapabilities: {
                  mode: "binary",
                  wire: "thinking",
                  supportsDisabled: true,
                },
              },
            ],
          },
        },
        async ({ client, events, persistence }) => {
          const session = await client.createSession();
          await createGoal(
            client,
            session.id,
            [
              "Verify this goal lifecycle handshake. No file, shell, network, or subagent work is required.",
              "First call GetGoal once to read the current goal state. An additional user instruction will arrive during this first request.",
              "After GetGoal returns, read that additional user instruction. It contains the success marker and final answer instructions.",
              "The goal is complete when you can return that exact marker. Then call UpdateGoal with status complete and give the requested answer.",
              "Do not invent a budget or create another goal.",
            ].join(" "),
          );
          await firstGoalRequest.promise;
          let steered: Awaited<
            ReturnType<RemoteClient["submitPromptAccepted"]>
          >;
          try {
            steered = await client.submitPromptAccepted(
              `Additional user instruction: the success marker is ${marker}. After GetGoal, call UpdateGoal with status complete, then return only ${marker}. Do not do any other work.`,
              {
                sessionId: session.id,
                clientRequestId: `live-steer-${marker}`,
              },
            );
            expect(steered.status).toBe("steered");
            expect(steered.steer?.status).toBe("steered");
          } finally {
            allowFirstRequest.resolve();
          }
          await vi.waitFor(
            async () => {
              const records = await persistence.list(session.id);
              const failed = (await client.getSnapshot()).runs.find(
                (run) =>
                  run.sessionId === session.id && run.status.kind === "error",
              );
              expect(failed, "the real goal run must succeed").toBeUndefined();
              expect(records.at(-1)?.type).toBe("clear");
            },
            { timeout: 120_000, interval: 100 },
          );
          const records = await persistence.list(session.id);
          const settled = records
            .filter((row) => row.tokensUsed !== undefined)
            .at(-1);
          expect(
            records.filter((row) => row.status === "complete"),
          ).toHaveLength(1);
          expect(records.filter((row) => row.type === "clear")).toHaveLength(1);
          expect(settled?.tokensUsed).toBeGreaterThan(0);
          expect((await client.getSnapshot()).goals ?? []).toEqual([]);
          await vi.waitFor(() => {
            expect(completionNotices(events)).toHaveLength(1);
          });
          const view = await client.getSessionView({ sessionId: session.id });
          expect(view.session.unconsumedSteers ?? []).toEqual([]);
          expect(view.runs).toHaveLength(1);
          expect(
            records
              .filter((row) => row.turnsUsed !== undefined)
              .map((row) => row.turnsUsed),
          ).toEqual([1]);
          expect(
            view.session.messages.filter(
              (message) => message.id === steered.userMessageId,
            ),
          ).toHaveLength(1);
          const assistantMessages = view.session.messages.filter(
            (message) => message.role === "assistant",
          );
          const assistantParts = assistantMessages.flatMap(
            (message) => message.parts,
          );
          expect(
            assistantParts.some(
              (part) =>
                part.type === "tool-call" &&
                part.call.name === "UpdateGoal" &&
                part.call.input.status === "complete" &&
                part.call.status === "completed",
            ),
          ).toBe(true);
          expect(
            assistantMessages
              .at(-1)
              ?.parts.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
              .trim(),
          ).toBe(marker);
          expect(calls).toBeLessThanOrEqual(8);
          expect(goalCalls).toBeGreaterThanOrEqual(2);
          // Only bounded, non-sensitive evidence is printed for opt-in runs.
          // eslint-disable-next-line no-console
          console.info(
            "GOAL_REAL_E2E_RESULT",
            JSON.stringify({
              model: "deepseek-flash",
              protocol: "openai-compatible",
              calls,
              goalCalls,
              turns: records.filter((row) => row.turnsUsed !== undefined).at(-1)
                ?.turnsUsed,
              tokens: settled?.tokensUsed,
              cachedTokens: settled?.cachedTokensUsed,
              usageIncomplete: settled?.usageIncomplete,
              completionNotices: completionNotices(events).length,
              markerReturned: true,
              automaticSteer: true,
              recoveryEntries: view.session.unconsumedSteers?.length ?? 0,
            }),
          );
        },
      );
    },
    150_000,
  );
});
