import * as messageStoreModule from "../../../../ohbaby-agent/src/core/message/database-store.js";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentUiBackendClient } from "../../../../ohbaby-agent/src/adapters/ui-persistent.js";
import {
  closeDatabase,
  getDatabase,
} from "../../../../ohbaby-agent/src/services/database/index.js";
import { createDaemonHttpServer } from "./server.js";
import { createSqliteGoalPersistence } from "../../../../ohbaby-agent/src/goals/persistence.js";
import { RunManager } from "../../../../ohbaby-agent/src/runtime/run-manager/manager.js";
import * as schedulerModule from "../../../../ohbaby-agent/src/core/tool-scheduler/scheduler.js";
import type { LLMClientInstance } from "../../../../ohbaby-agent/src/core/llm-client/index.js";
import type { InterfaceProviderStreamEvent } from "../../../../ohbaby-agent/src/services/interface-providers/index.js";

interface FixtureRpcResponse {
  readonly ok: boolean;
  readonly result: {
    promptId: string;
    permissionEpoch: string;
    bindingGeneration: number;
  };
  readonly error?: { message: string };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`observation exceeded ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeDatabase();
});

it.each([
  { mode: "stop", holdMs: 1800 },
  { mode: "owed-stop", holdMs: 1800 },
  { mode: "deadline", holdMs: 1800 },
  { mode: "deadline", holdMs: 5600 },
] as const)(
  "real persistent HTTP service accepts $mode during $holdMs ms independent SQLite ownership",
  async ({ mode, holdMs }) => {
    const root = await mkdtemp(join(tmpdir(), "sqlite-service-contention-"));
    const workdir = join(root, "workspace");
    await mkdir(workdir);
    const home = join(root, "home");
    await mkdir(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("OHBABY_HOME", home);
    vi.stubEnv("OHBABY_STORAGE_ROOT", join(root, "storage"));
    const dbPath = join(root, "fixture.db");
    const entered = deferred<undefined>();
    const cancelled = deferred<undefined>();
    const blockedWrite = deferred<undefined>();
    const releaseTool = deferred<undefined>();
    const terminalSaveEntered = deferred<undefined>();
    let terminalPartId: string | undefined;
    const persistedOrder: string[] = [];
    const timings: Record<string, number> = {};
    let providerSteps = 0;
    let toolCalls = 0;
    let armed = false;
    const stamp = (key: string): void => {
      timings[key] = performance.now();
    };
    if (mode === "owed-stop") {
      const createStore = messageStoreModule.createDatabaseMessageStore;
      vi.spyOn(
        messageStoreModule,
        "createDatabaseMessageStore",
      ).mockImplementation((options) => {
        const store = createStore(options);
        const update = store.updatePart.bind(store);
        store.updatePart = (partId, patch, at): ReturnType<typeof update> => {
          const result = update(partId, patch, at);
          if (patch.state?.status === "completed") {
            terminalPartId = partId;
            stamp("terminalSaveEntered");
            terminalSaveEntered.resolve(undefined);
            return result.then((part) => {
              persistedOrder.push("tool-result");
              stamp("terminalSaved");
              return part;
            });
          }
          return result;
        };
        return store;
      });
      // Observe the actual root AbortSignal emitted synchronously by RunManager.cancel.
      // Explicit call below retains the original controller receiver.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const abort = AbortController.prototype.abort;
      vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (
        this: AbortController,
        reason,
      ) {
        if (reason === "user-stop")
          this.signal.addEventListener(
            "abort",
            () => {
              stamp("cancelSignal");
              cancelled.resolve(undefined);
            },
            { once: true },
          );
        abort.call(this, reason);
      });
    }
    if (mode !== "stop") {
      const create = schedulerModule.createToolScheduler;
      vi.spyOn(schedulerModule, "createToolScheduler").mockImplementation(
        (options) => {
          const scheduler = create({
            ...options,
            config: {
              ...options.config,
              timeout: {
                defaultTimeout: mode === "owed-stop" ? 10000 : 300,
                byTool: {
                  contention_fixture: mode === "owed-stop" ? 10000 : 300,
                },
              },
            },
          });
          scheduler.register({
            name: "contention_fixture",
            description: "Local fixture",
            source: "builtin",
            category: "readonly",
            parametersJsonSchema: { type: "object", properties: {} },
            execute: async (_params, context) => {
              toolCalls++;
              stamp("executionStart");
              if (mode === "deadline")
                timings.deadlineDue = timings.executionStart + 300;
              entered.resolve(undefined);
              if (mode === "owed-stop") {
                await releaseTool.promise;
                stamp("toolReturned");
                return { success: true, output: "owed-success-result" };
              }
              await new Promise<void>((resolve) => {
                context.signal.addEventListener(
                  "abort",
                  () => {
                    stamp("cancelSignal");
                    cancelled.resolve(undefined);
                    resolve();
                  },
                  { once: true },
                );
              });
              stamp("cleanupCallback");
              return { success: false, output: "fixture cancelled" };
            },
          });
          return scheduler;
        },
      );
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(
        (callback: () => void, delay?: number, ...args: unknown[]) =>
          schedule(() => {
            if (delay === 300) stamp("deadlineCallback");
            Reflect.apply(callback, undefined, args);
          }, delay),
      );
    }
    const abortError = Object.assign(new Error("fixture aborted"), {
      name: "AbortError",
    });
    const llmClient: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        apiKeyEnv: "FIXTURE_ONLY",
        baseUrl: "https://fixture.invalid",
        interfaceProvider: "openai-compatible",
        temperature: 0,
        maxTokens: 128,
        modelProfiles: [
          {
            model: "fixture",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: (error) => error === abortError,
        streamResponse(request) {
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (request.purpose === "session-title") {
                yield { textDelta: "Fixture", finishReason: "stop" };
                return;
              }
              providerSteps++;
              if (providerSteps > 1) {
                yield { textDelta: "done", finishReason: "stop" };
                return;
              }
              if (mode !== "stop") {
                yield {
                  toolCallDeltas: [
                    {
                      index: 0,
                      id: "call-fixture",
                      name: "contention_fixture",
                      argumentsDelta: "{}",
                    },
                  ],
                  finishReason: "tool_calls",
                };
                return;
              }
              stamp("executionStart");
              entered.resolve(undefined);
              const signal = request.signal;
              if (!signal)
                throw new Error("Fixture requires run cancellation signal");
              try {
                await new Promise<never>((_, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      stamp("cancelSignal");
                      cancelled.resolve(undefined);
                      reject(abortError);
                    },
                    { once: true },
                  );
                });
              } finally {
                stamp("cleanupCallback");
              }
            })(),
          );
        },
      },
    };
    const backend = createPersistentUiBackendClient({
      dbPath,
      llmClient,
      workdir,
      hookExecutor: {
        execute(point) {
          if (point === "post-run") stamp("postRunCleanup");
          return Promise.resolve();
        },
      },
    });
    const originalAbort = backend.abortRun.bind(backend);
    vi.spyOn(backend, "abortRun").mockImplementation((runId) => {
      stamp("handlerEntry");
      return originalAbort(runId);
    });
    // Explicit .call(this, ...) below retains the real receiver while observing it.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalCancel = RunManager.prototype.cancel;
    vi.spyOn(RunManager.prototype, "cancel").mockImplementation(function (
      this: RunManager,
      runId,
      reason,
    ) {
      stamp("stopAccepted");
      originalCancel.call(this, runId, reason);
    });
    const server = createDaemonHttpServer({
      backend,
      host: "127.0.0.1",
      port: 0,
      authToken: "fixture-token",
      scopeRoot: workdir,
    });
    let holder: ReturnType<typeof fork> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const rpc = async (
      method: string,
      params: unknown[] = [],
    ): Promise<FixtureRpcResponse> => {
      const response = await fetch(`${server.url}/api/rpc`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-token",
          "content-type": "application/json",
          "x-ohbaby-directory": workdir,
        },
        body: JSON.stringify({
          id: method,
          clientId: "fixture-client",
          method,
          params,
        }),
      });
      const result = (await response.json()) as FixtureRpcResponse;
      if (!result.ok)
        process.stdout.write(
          `RPC_FAILURE ${method} ${JSON.stringify(result)}\n`,
        );
      return result;
    };
    try {
      await server.start();
      expect(
        (
          await rpc("initializeClient", [
            { startupSessionMode: { type: "fresh" } },
          ])
        ).ok,
      ).toBe(true);
      const events = await fetch(
        `${server.url}/api/events?clientId=fixture-client`,
        {
          headers: {
            authorization: "Bearer fixture-token",
            "x-ohbaby-directory": workdir,
          },
        },
      );
      if (!events.body) throw new Error("Missing SSE response body");
      const reader = events.body.getReader();
      await reader.read();
      const first = await rpc("submitPromptAccepted", ["fixture"]);
      expect(first.ok).toBe(true);
      await within(entered.promise, 5000);
      await reader.cancel();
      stamp("sseDisconnected");
      const snapshot = await backend.getSnapshot();
      const run = snapshot.runs.find((run) => run.status.kind === "running");
      if (!run) throw new Error("Fixture run is not active");
      const db = getDatabase();
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        try {
          exec(sql);
        } catch (error) {
          if (armed && sql === "BEGIN IMMEDIATE") {
            stamp("writeBlocked");
            blockedWrite.resolve(undefined);
            armed = false;
          }
          throw error;
        }
      });
      const lockHolder = fork(
        join(
          process.cwd(),
          "packages/ohbaby-agent/src/services/database/testing/lock-holder.mjs",
        ),
        [dbPath, String(holdMs)],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      holder = lockHolder;
      await within(
        new Promise<void>((resolve, reject) => {
          lockHolder.once("message", () => {
            resolve();
          });
          lockHolder.once("error", reject);
        }),
        1000,
      );
      stamp("lockAcknowledged");
      armed = true;
      const queued =
        mode === "owed-stop"
          ? Promise.resolve({ ok: true })
          : holdMs < 5000
            ? rpc("submitPromptAccepted", [
                "queued",
                { sessionId: run.sessionId },
              ])
            : createSqliteGoalPersistence(db)
                .append(run.sessionId, {
                  type: "create",
                  goalId: "contention",
                  objective: "fixture",
                })
                .then(
                  () => ({ ok: true }),
                  () => ({ ok: false }),
                );
      void queued.catch(() => undefined);
      let laterWrite: Promise<void> | undefined;
      if (mode === "owed-stop") {
        releaseTool.resolve(undefined);
        await within(terminalSaveEntered.promise, 1000);
      }
      await within(blockedWrite.promise, 1000);
      if (mode === "owed-stop") {
        expect(timings.terminalSaveEntered).toBeLessThanOrEqual(
          timings.writeBlocked,
        );
        expect(persistedOrder).toEqual([]);
        const before = db
          .prepare<{ data: string }>("SELECT data FROM part WHERE id = ?")
          .get(terminalPartId ?? "missing");
        expect(before?.data).not.toContain("owed-success-result");
        laterWrite = createSqliteGoalPersistence(db)
          .append(run.sessionId, {
            type: "create",
            goalId: "after-result",
            objective: "fixture",
          })
          .then(() => {
            persistedOrder.push("later-write");
          });
        void laterWrite.catch(() => undefined);
      }
      let heartbeatCount = 0;
      let maxHeartbeatGap = 0;
      let lastBeat = performance.now();
      heartbeat = setInterval(() => {
        heartbeatCount++;
        const now = performance.now();
        maxHeartbeatGap = Math.max(maxHeartbeatGap, now - lastBeat);
        lastBeat = now;
      }, 10);
      let stop: Promise<unknown> | undefined;
      if (mode !== "deadline") {
        stamp("clientStopSent");
        stop = rpc("abortRun", [
          run.id,
          {
            sessionId: run.sessionId,
            runtimeEpoch: first.result.permissionEpoch,
            bindingGeneration: first.result.bindingGeneration,
          },
        ]).then((value) => {
          stamp("rpcReply");
          return value;
        });
        void stop.catch(() => undefined);
      }
      await within(cancelled.promise, 1000);
      expect(
        timings.cancelSignal -
          (mode !== "deadline" ? timings.clientStopSent : timings.deadlineDue),
      ).toBeLessThan(1000);
      expect(timings.writeBlocked).toBeLessThan(timings.cancelSignal);
      if (mode !== "deadline") {
        expect(timings.handlerEntry).toBeGreaterThanOrEqual(
          timings.clientStopSent,
        );
        expect(timings.stopAccepted).toBeGreaterThanOrEqual(
          timings.handlerEntry,
        );
      } else {
        expect(timings.deadlineCallback).toBeGreaterThan(timings.writeBlocked);
        expect(toolCalls).toBe(1);
      }
      await stop;
      const queuedResult = await queued;
      await laterWrite;
      clearInterval(heartbeat);
      expect(heartbeatCount).toBeGreaterThan(0);
      expect(maxHeartbeatGap).toBeLessThan(200);
      expect(queuedResult.ok).toBe(holdMs < 5000);
      if (holdMs < 5000) {
        const outcome = await backend.waitForPrompt(first.result.promptId);
        expect(outcome.prompt.status).toBe(
          mode !== "deadline" ? "interrupted" : "succeeded",
        );
      } else {
        const outcome = await within(
          backend.waitForPrompt(first.result.promptId),
          8000,
        );
        process.stdout.write(`EXHAUSTED_OUTCOME ${outcome.prompt.status}\n`);
        expect(outcome.prompt.status).toBe("failed");
        expect(toolCalls).toBe(1);
        expect(providerSteps).toBe(1);
      }
      if (mode === "owed-stop") {
        await laterWrite;
        expect(persistedOrder).toEqual(["tool-result", "later-write"]);
        expect(timings.terminalSaveEntered).toBeLessThan(
          timings.clientStopSent,
        );
        expect(timings.terminalSaved).toBeGreaterThan(timings.cancelSignal);
        const rows = db
          .prepare<{ data: string }>("SELECT data FROM part WHERE id = ?")
          .all(terminalPartId ?? "missing");
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].data)).toMatchObject({
          type: "tool",
          state: { status: "completed", output: "owed-success-result" },
        });
        expect(toolCalls).toBe(1);
        expect(providerSteps).toBe(1);
      }
      const baseline = timings.lockAcknowledged;
      process.stdout.write(
        "T08_SERVICE " +
          JSON.stringify({
            mode,
            holdMs,
            heartbeatCount,
            maxHeartbeatGapMs: maxHeartbeatGap,
            timingsMs: Object.fromEntries(
              Object.entries(timings).map(([key, value]) => [
                key,
                Math.round(value - baseline),
              ]),
            ),
            toolCalls,
            providerSteps,
            persistedOrder,
          }) +
          "\n",
      );
    } catch (error) {
      process.stdout.write(`TIMING_DEBUG ${JSON.stringify(timings)}\n`);
      throw error;
    } finally {
      clearInterval(heartbeat);
      const remainingHolder = holder;
      if (remainingHolder?.connected)
        await within(
          new Promise<void>((resolve) =>
            remainingHolder.once("exit", () => {
              resolve();
            }),
          ),
          6000,
        ).catch(() => holder?.kill());
      await server.stop();
      await backend.dispose();
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
