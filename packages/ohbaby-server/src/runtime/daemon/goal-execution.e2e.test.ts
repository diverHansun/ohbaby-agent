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
  it("queues the user without interruption, hides complete once, settles tail usage in SQLite, then runs the user", async () => {
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
        const queued = await client.submitPromptAccepted("queued user", {
          sessionId: session.id,
        });
        const pending = await client.getSessionView({ sessionId: session.id });
        expect(
          pending.prompts.find((row) => row.promptId === queued.promptId)
            ?.status,
        ).toBe("queued");
        expect(goalSignal?.aborted).toBe(false);
        expect(order).toEqual(["goal"]);
        expect(
          (await persistence.list(session.id))
            .filter((row) => row.turnsUsed !== undefined)
            .map((row) => row.turnsUsed),
        ).toEqual([1]);

        complete.resolve();
        await tailStarted.promise;
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
    "uses real DeepSeek and production UpdateGoal, persists usage, and returns the final marker",
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
      let calls = 0;
      let goalCalls = 0;
      provider.streamResponse = (request): ReturnType<typeof open> => {
        if (calls >= 8) throw new Error("Real goal E2E request cap reached");
        calls++;
        if (request.purpose !== "session-title") goalCalls++;
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
              "The checkable success condition is that you have read this instruction and can return the exact marker below.",
              "That verification is already complete by reading it. Call the available UpdateGoal tool with status complete now.",
              "After the tool succeeds, give your final answer consisting only of this marker:",
              marker,
              "Do not invent a budget or create another goal.",
            ].join(" "),
          );
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
            }),
          );
        },
      );
    },
    150_000,
  );
});
