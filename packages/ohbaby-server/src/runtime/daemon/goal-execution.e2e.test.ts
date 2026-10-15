/** HTTP daemon + SQLite + production goal tools/runtime. Set
 * OHBABY_RUN_GOAL_REAL_E2E=1 for the paid DeepSeek case (DEEPSEEK_API_KEY in .env).
 * Kept beside model-idle.e2e.test.ts so both use the existing E2E runner.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEvent, UiMessage } from "ohbaby-sdk";
import { parseSlashCommandInput, resolveSlashCommand } from "ohbaby-sdk";
import { buildCommandCatalog } from "../../../../ohbaby-agent/src/commands/catalog.js";
import {
  createPersistentUiBackendClient,
  closePersistentUiBackendDatabase,
} from "../../../../ohbaby-agent/src/adapters/ui-persistent.js";
import { loadEnvFile } from "../../../../ohbaby-agent/src/config/llm/loaders.js";
import { createDatabaseMessageStore } from "../../../../ohbaby-agent/src/core/message/database-store.js";
import {
  getMessageOrigin,
  isModelContextPart,
} from "../../../../ohbaby-agent/src/core/message/origin.js";
import type { LLMClientInstance } from "../../../../ohbaby-agent/src/core/llm-client/types.js";
import { createSqliteGoalPersistence } from "../../../../ohbaby-agent/src/goals/persistence.js";
import type { GoalPersistencePort } from "../../../../ohbaby-agent/src/goals/types.js";
import { getDatabase } from "../../../../ohbaby-agent/src/services/database/index.js";
import { createInterfaceProvider } from "../../../../ohbaby-agent/src/services/interface-providers/index.js";
import type {
  InterfaceProviderRequest,
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
    reconnect: () => RemoteClient;
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
  const reconnectedClients: RemoteClient[] = [];
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
      reconnect: () => {
        const reconnected = createRemoteUiBackendClient({
          authToken,
          host: "127.0.0.1",
          port: server.port,
        });
        reconnectedClients.push(reconnected);
        return reconnected;
      },
    });
  } finally {
    await Promise.all(reconnectedClients.map((item) => item.dispose()));
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
  const resolved = resolveSlashCommand(
    buildCommandCatalog(),
    parseSlashCommandInput(`/goal ${objective}`),
    { surface: "tui" },
  );
  if (!resolved.ok) throw new Error(resolved.error.message);
  const result = await client.executeCommand({
    commandId: resolved.command.id,
    path: resolved.path,
    clientInvocationId: randomUUID(),
    raw: resolved.raw,
    rawArgs: resolved.rawArgs,
    argv: resolved.argv,
    body: resolved.body,
    sessionId,
    surface: "tui",
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

function uiMessageText(message: UiMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function lastUserText(request: InterfaceProviderRequest): string {
  const message = request.messages
    .filter((item) => item.role === "user")
    .at(-1);
  if (!message) throw new Error("Expected user input in the model request");
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => ("text" in part ? part.text : ""))
        .join("\n");
}

describe("goal execution through the HTTP daemon", () => {
  it("separates two goal turns from their live and replay display while preserving runtime context, title and silent counters", async () => {
    const firstRequest = deferred();
    const releaseFirst = deferred();
    const objective =
      "Verify the cobalt telescope handoff within exactly 2 turns\n\n  汇总每轮结果，并注明来源";
    const requests: InterfaceProviderRequest[] = [];
    const titles: InterfaceProviderRequest[] = [];
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
                titles.push(request);
                yield {
                  textDelta: "Verify cobalt telescope handoff",
                  finishReason: "stop",
                };
                return;
              }
              const index = requests.push(request) - 1;
              if (index === 0) {
                firstRequest.resolve();
                await releaseFirst.promise;
                yield {
                  toolCallDeltas: [
                    {
                      index: 0,
                      id: "set_two_turn_limit",
                      name: "SetGoalBudget",
                      argumentsDelta: '{"value":2,"unit":"turns"}',
                    },
                  ],
                  finishReason: "tool_calls",
                  tokenUsage: usage(100, 20),
                };
              } else if (index <= 2) {
                yield {
                  textDelta: `GOAL_TURN_${String(index)}_OK`,
                  finishReason: "stop",
                  tokenUsage: usage(100, 20),
                };
              } else if (index === 3) {
                yield {
                  toolCallDeltas: [
                    {
                      index: 0,
                      id: "read_blocked_goal",
                      name: "GetGoal",
                      argumentsDelta: "{}",
                    },
                  ],
                  finishReason: "tool_calls",
                  tokenUsage: usage(100, 20),
                };
              } else {
                yield {
                  textDelta: "ORDINARY_INPUT_OK",
                  finishReason: "stop",
                  tokenUsage: usage(100, 20),
                };
              }
            })(),
          );
        },
      },
    };
    await withDaemon(
      llmClient,
      async ({ client, events, persistence, reconnect }) => {
        try {
          const session = await client.createSession();
          await createGoal(client, session.id, objective);
          await firstRequest.promise;
          const initial = (await client.getSnapshot()).goals?.find(
            (item) => item.sessionId === session.id,
          )?.goal;
          expect(initial).toMatchObject({
            status: "active",
            turnsUsed: 1,
          });
          expect(typeof initial?.wallClockMs).toBe("number");
          expect(initial).not.toHaveProperty("turnBudget");
          releaseFirst.resolve();
          await vi.waitFor(async () => {
            expect(
              (await persistence.list(session.id)).filter(
                (record) => record.tokensUsed !== undefined,
              ),
            ).toHaveLength(2);
            expect(
              (await client.getSessionView({ sessionId: session.id })).goal,
            ).toMatchObject({
              status: "ready",
              value: { status: "blocked", turnsUsed: 2, turnBudget: 2 },
            });
          });
          const view = await client.getSessionView({ sessionId: session.id });
          const replayUserMessages = view.session.messages.filter(
            (message) => message.role === "user",
          );
          expect(replayUserMessages.map(uiMessageText)).toEqual([
            objective,
            "Goal auto-continue (turn 2)",
          ]);
          await vi.waitFor(() => {
            const liveUserMessages = events.flatMap((event) =>
              event.type === "message.appended" &&
              event.sessionId === session.id &&
              event.message.role === "user"
                ? [event.message]
                : [],
            );
            expect(liveUserMessages.map(uiMessageText)).toEqual(
              replayUserMessages.map(uiMessageText),
            );
          });
          expect(requests).toHaveLength(3);
          const turnPrompts = [
            lastUserText(requests[0]),
            lastUserText(requests[2]),
          ];
          turnPrompts.forEach((text, index) => {
            expect(text).toContain(
              `<untrusted_objective>\n${objective}\n</untrusted_objective>`,
            );
            expect(text).toContain(
              `Progress: ${String(index + 1)} continuation turns`,
            );
            expect(text).toContain("<environment_context>");
            expect(text).not.toContain("Goal started");
            expect(text).not.toContain("Goal auto-continue");
            expect(text.match(/<untrusted_objective>/gu)).toHaveLength(1);
          });
          expect(
            requests[0].messages.filter((message) => message.role === "system"),
          ).toEqual(
            requests[2].messages.filter((message) => message.role === "system"),
          );
          await vi.waitFor(() => {
            expect(titles).toHaveLength(1);
          });
          // Title input normalizes whitespace, while chat/model history keeps it.
          expect(lastUserText(titles[0])).toContain(
            "Verify the cobalt telescope handoff within exactly 2 turns 汇总每轮结果，并注明来源",
          );
          expect(lastUserText(titles[0])).not.toMatch(
            /Goal started|Goal auto-continue/u,
          );
          expect(view.session.title).toBe("Verify cobalt telescope handoff");
          const stored = (
            await createDatabaseMessageStore().listBySession(session.id)
          ).filter((message) => message.info.role === "user");
          expect(stored).toHaveLength(2);
          stored.forEach((message, index) => {
            expect(getMessageOrigin(message)).toBe("user");
            const body = message.parts.find(
              (part) => part.type === "text" && !isModelContextPart(part),
            );
            if (body?.type !== "text")
              throw new Error("Expected persisted goal body");
            expect(body.text).toContain(objective);
            expect(body.metadata?.displayText).toBe(
              uiMessageText(replayUserMessages[index]),
            );
            expect(body.metadata).not.toHaveProperty("kind");
            const runtime = message.parts.filter(isModelContextPart);
            expect(runtime).toHaveLength(1);
            if (runtime[0]?.type !== "text")
              throw new Error("Expected runtime context part");
            expect(runtime[0].text).toContain("<environment_context>");
          });
          if (view.goal.status !== "ready" || !view.goal.value)
            throw new Error("Expected blocked goal projection");
          const stoppedGoal = view.goal.value;
          expect(stoppedGoal.wallClockMs).toBeGreaterThan(0);
          expect(
            Object.keys(stoppedGoal).some((key) => /token/iu.test(key)),
          ).toBe(false);
          const freshClient = reconnect();
          await freshClient.selectSession(session.id);
          const snapshot = await freshClient.getSnapshot();
          expect(
            snapshot.goals?.find((item) => item.sessionId === session.id)?.goal,
          ).toEqual(stoppedGoal);
          expect(
            (await freshClient.getSessionView({ sessionId: session.id })).goal,
          ).toEqual(view.goal);
          expect(
            snapshot.sessions
              .find((item) => item.id === session.id)
              ?.messages.filter((message) => message.role === "user")
              .map(uiMessageText),
          ).toEqual(replayUserMessages.map(uiMessageText));
          await vi.waitFor(() => {
            const updates = events.filter(
              (event): event is Extract<UiEvent, { type: "goal.updated" }> =>
                event.type === "goal.updated" && event.sessionId === session.id,
            );
            expect(updates.at(-1)).toMatchObject({ goal: stoppedGoal });
            expect(updates.some((event) => event.goal?.turnsUsed === 1)).toBe(
              true,
            );
            expect(updates.some((event) => event.goal?.turnsUsed === 2)).toBe(
              true,
            );
          });
          const goalNotices = events.filter(
            (event) =>
              event.type === "notice.emitted" &&
              event.notice.source === "goals",
          );
          expect(goalNotices).toHaveLength(3); // creation, explicit budget, budget exhaustion only
          const ordinary =
            "Read the current goal explicitly; do not resume it.";
          const accepted = await client.submitPromptAccepted(ordinary, {
            sessionId: session.id,
          });
          expect(
            (
              await client.waitForPrompt(accepted.promptId, {
                signal: AbortSignal.timeout(10_000),
              })
            ).prompt.status,
          ).toBe("succeeded");
          expect(lastUserText(requests[3]).startsWith(ordinary)).toBe(true);
          expect(lastUserText(requests[3])).not.toContain(objective);
          expect(lastUserText(requests[3])).not.toMatch(
            /currently paused|<untrusted_objective>|\/goal resume/u,
          );
          expect(lastUserText(requests[3])).toContain("<environment_context>");
          const explicitGoal = requests[4].messages.find(
            (message) =>
              message.role === "tool" && message.callId === "read_blocked_goal",
          )?.content;
          expect(explicitGoal).toContain(`Goal: ${objective}`);
          expect(explicitGoal).toContain("Tokens:");
          expect(
            (await client.getSessionView({ sessionId: session.id })).goal,
          ).toEqual(view.goal);
          expect(
            events.filter(
              (event) =>
                event.type === "notice.emitted" &&
                event.notice.source === "goals",
            ),
          ).toHaveLength(goalNotices.length);
        } finally {
          releaseFirst.resolve();
        }
      },
    );
  }, 20_000);

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
          turnsUsed: 3,
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
      expect(
        events.some(
          (event) =>
            event.type === "goal.updated" &&
            event.goal?.status === "active" &&
            event.goal.turnBudget === 5 &&
            event.goal.turnsUsed >= 3,
        ),
      ).toBe(true);
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
                expect(lastUserText(request)).toBe("steered user instruction");
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
                expect(lastUserText(request).startsWith("queued user")).toBe(
                  true,
                );
                expect(lastUserText(request)).not.toMatch(
                  /currently paused|<untrusted_objective>|\/goal resume/u,
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
    "uses real DeepSeek across two displayed goal turns with automatic steer, full context and completion",
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
      const modelRequests: InterfaceProviderRequest[] = [];
      const titleRequests: InterfaceProviderRequest[] = [];
      provider.streamResponse = async (request): ReturnType<typeof open> => {
        if (calls >= 8) throw new Error("Real goal E2E request cap reached");
        calls++;
        if (request.purpose === "session-title") titleRequests.push(request);
        else {
          modelRequests.push(request);
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
        async ({ client, events, persistence, reconnect }) => {
          const session = await client.createSession();
          const objective = [
            "Verify the cobalt telescope two-turn lifecycle handshake. No file, shell, network, or subagent work is required.",
            "The success condition requires observing a SECOND admitted goal turn (Progress: 2 continuation turns).",
            "On the FIRST admitted turn, call GetGoal once, read the additional user instruction, then end your response with FIRST_TURN_READY while keeping the goal active so the runtime can admit the second turn.",
            "On the SECOND admitted turn, the condition is satisfied: call UpdateGoal with status complete, then return the exact success marker supplied by the additional user instruction.",
            "Do not invent a budget or create another goal.",
          ].join(" ");
          await createGoal(client, session.id, objective);
          await firstGoalRequest.promise;
          let steered: Awaited<
            ReturnType<RemoteClient["submitPromptAccepted"]>
          >;
          try {
            steered = await client.submitPromptAccepted(
              `Additional user instruction: the success marker is ${marker}. In turn 1, after GetGoal, return only FIRST_TURN_READY and keep the goal active. In turn 2, call UpdateGoal with status complete, then return only ${marker}. Do not do any other work.`,
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
          // Emit bounded observations before assertions so a test-oracle failure
          // still leaves useful request/accounting evidence without request data.
          // eslint-disable-next-line no-console
          console.info(
            "GOAL_REAL_E2E_OBSERVED",
            JSON.stringify({
              calls,
              goalCalls,
              turns: records.filter((row) => row.turnsUsed !== undefined).at(-1)
                ?.turnsUsed,
              tokens: settled?.tokensUsed,
              cachedTokens: settled?.cachedTokensUsed,
              usageIncomplete: settled?.usageIncomplete,
            }),
          );
          const view = await client.getSessionView({ sessionId: session.id });
          expect(view.session.unconsumedSteers ?? []).toEqual([]);
          expect(view.runs).toHaveLength(2);
          expect(
            records
              .filter((row) => row.turnsUsed !== undefined)
              .map((row) => row.turnsUsed),
          ).toEqual([1, 2]);
          const goalMessages = view.session.messages.filter(
            (message) =>
              message.role === "user" && message.id !== steered.userMessageId,
          );
          expect(goalMessages.map(uiMessageText)).toEqual([
            objective,
            "Goal auto-continue (turn 2)",
          ]);
          const liveGoalMessages = events.flatMap((event) =>
            event.type === "message.appended" &&
            event.message.role === "user" &&
            event.message.id !== steered.userMessageId
              ? [event.message]
              : [],
          );
          expect(liveGoalMessages.map(uiMessageText)).toEqual(
            goalMessages.map(uiMessageText),
          );
          for (const turn of [1, 2]) {
            const progressLine = new RegExp(
              `^Progress: ${String(turn)} continuation turns,`,
              "m",
            );
            const request = modelRequests.find((item) =>
              progressLine.test(lastUserText(item)),
            );
            if (!request)
              throw new Error(`Missing real goal turn ${String(turn)} request`);
            const body = lastUserText(request);
            expect(body).toContain(objective);
            expect(body).toContain("<environment_context>");
            expect(body).not.toMatch(/Goal started|Goal auto-continue/u);
          }
          const steerRequest = modelRequests.find((request) =>
            lastUserText(request).startsWith("Additional user instruction:"),
          );
          if (!steerRequest)
            throw new Error("Expected real protected user input request");
          expect(lastUserText(steerRequest)).not.toMatch(
            /currently paused|<untrusted_objective>|\/goal resume/u,
          );
          expect(titleRequests).toHaveLength(1);
          expect(lastUserText(titleRequests[0])).toContain("cobalt telescope");
          expect(lastUserText(titleRequests[0])).not.toMatch(
            /Goal started|Goal auto-continue/u,
          );
          expect(view.session.title).not.toMatch(
            /Goal started|Goal auto-continue/u,
          );
          expect(view.session.title.trim().length).toBeGreaterThan(0);
          const freshClient = reconnect();
          await freshClient.selectSession(session.id);
          const reloaded = await freshClient.getSessionView({
            sessionId: session.id,
          });
          expect(
            reloaded.session.messages
              .filter(
                (message) =>
                  message.role === "user" &&
                  message.id !== steered.userMessageId,
              )
              .map(uiMessageText),
          ).toEqual(goalMessages.map(uiMessageText));
          expect(reloaded.goal).toEqual({ status: "ready", value: null });
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
              firstAndContinuationDisplay: true,
              fullModelBodyAndRuntimeContext: true,
              titleFromObjective: true,
              reconnectedReplay: true,
              recoveryEntries: view.session.unconsumedSteers?.length ?? 0,
            }),
          );
        },
      );
    },
    150_000,
  );
});
