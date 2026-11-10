import { SessionSubagentHost } from "../agents/subagent-host.js";
import { DatabasePromptSubmissionStore } from "../runtime/prompt-scheduler/database-store.js";
import { DatabaseCurrentRunInputStore } from "../runtime/prompt-scheduler/current-run-inputs.js";
import { DatabaseSubagentExecutionStore } from "../agents/subagents/execution-store.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiEvent, UiPromptReceipt, UiRun } from "ohbaby-sdk";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import type { LLMClientInstance } from "ohbaby-llm";
import {
  closeDatabase,
  getDatabase,
  schema,
} from "../services/database/index.js";
import { createDatabaseRunLedger } from "../runtime/run-ledger/index.js";
import {
  createDatabaseMessageStore,
  insertMessageRow,
  insertPartRow,
} from "../core/message/database-store.js";
import { createSqliteGoalPersistence } from "../goals/index.js";
import {
  goalTodoWorkScopeId,
  recoverTodosFromMessages,
} from "../tools/todo.js";
import type { HookExecutor } from "../runtime/run-manager/index.js";
import type { SnapshotService } from "../snapshot/index.js";
import {
  createTemporarySessionTitle,
  searchGlobalSessions,
} from "../services/session/index.js";
import {
  createPersistentUiBackendClient,
  type PersistentUiBackendClient,
} from "./ui-persistent.js";

import * as uiInProcess from "./ui-inprocess.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

const TITLE_GENERATION_PROMPT_MARKER =
  "Write a short conversation title that identifies the user's task.";

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function createProviderStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createFakeLLMClient(
  events: readonly InterfaceProviderStreamEvent[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              {
                textDelta: titleTextForSessionTitleRequest(request),
                finishReason: "stop",
              },
            ]),
          );
        }
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createBlockingLLMClient(input: {
  readonly release: Promise<undefined>;
  readonly started: Deferred<undefined>;
  readonly text: string;
}): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              {
                textDelta: titleTextForSessionTitleRequest(request),
                finishReason: "stop",
              },
            ]),
          );
        }
        input.started.resolve(undefined);
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            InterfaceProviderStreamEvent,
            void,
            unknown
          > {
            await input.release;
            yield { textDelta: input.text, finishReason: "stop" };
          })(),
        );
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createConcurrentBlockingLLMClient(input: {
  readonly release: Promise<undefined>;
  readonly onStarted: (request: InterfaceProviderRequest) => void;
}): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              {
                textDelta: titleTextForSessionTitleRequest(request),
                finishReason: "stop",
              },
            ]),
          );
        }
        input.onStarted(request);
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            InterfaceProviderStreamEvent,
            void,
            unknown
          > {
            await input.release;
            yield { textDelta: "done", finishReason: "stop" };
          })(),
        );
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createFailingLLMClient(
  error: Error & { readonly status?: number },
): LLMClientInstance<FakeSdkClient> {
  const client = createFakeLLMClient([]);
  return {
    ...client,
    provider: {
      ...client.provider,
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "Failure", finishReason: "stop" },
            ]),
          );
        }
        return Promise.reject(error);
      },
    },
  };
}

function createConcurrentMixedOutcomeLLMClient(input: {
  readonly release: Promise<undefined>;
  readonly blockedStarted: Deferred<undefined>;
}): LLMClientInstance<FakeSdkClient> {
  const client = createFakeLLMClient([]);
  return {
    ...client,
    provider: {
      ...client.provider,
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "Concurrent", finishReason: "stop" },
            ]),
          );
        }
        const text = lastPersistentRequestMessageText(request);
        if (text.includes("fail")) {
          return Promise.reject(
            Object.assign(new Error("Authorization: Bearer secret-token"), {
              status: 401,
            }),
          );
        }
        input.blockedStarted.resolve(undefined);
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            InterfaceProviderStreamEvent,
            void,
            unknown
          > {
            await input.release;
            yield { textDelta: "done", finishReason: "stop" };
          })(),
        );
      },
    },
  };
}

function createAbortableBlockingLLMClient(input: {
  readonly release: Promise<undefined>;
  readonly startedTexts: string[];
  readonly partialText?: string;
}): LLMClientInstance<FakeSdkClient> {
  const abortError = Object.assign(new Error("aborted"), {
    name: "AbortError",
  });
  const client = createFakeLLMClient([]);
  return {
    ...client,
    provider: {
      ...client.provider,
      isAbortError(error: unknown): boolean {
        return error === abortError;
      },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "Abort test", finishReason: "stop" },
            ]),
          );
        }
        input.startedTexts.push(lastPersistentRequestMessageText(request));
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            InterfaceProviderStreamEvent,
            void,
            unknown
          > {
            if (input.partialText) yield { textDelta: input.partialText };
            if (request.signal?.aborted) throw abortError;
            await Promise.race([
              input.release,
              new Promise<never>((_resolve, reject) => {
                request.signal?.addEventListener(
                  "abort",
                  () => {
                    reject(abortError);
                  },
                  { once: true },
                );
              }),
            ]);
            if (request.signal?.aborted) {
              throw abortError;
            }
            yield { textDelta: "done", finishReason: "stop" };
          })(),
        );
      },
    },
  };
}

function createDelayedAbortSettlementLLMClient(input: {
  readonly abortObserved: Deferred<undefined>;
  readonly settleAbortedRun: Promise<undefined>;
  readonly startedTexts: string[];
}): LLMClientInstance<FakeSdkClient> {
  const abortError = Object.assign(new Error("aborted"), {
    name: "AbortError",
  });
  const client = createFakeLLMClient([]);
  return {
    ...client,
    provider: {
      ...client.provider,
      isAbortError(error: unknown): boolean {
        return error === abortError;
      },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "Abort barrier", finishReason: "stop" },
            ]),
          );
        }
        const text = lastPersistentRequestMessageText(request);
        input.startedTexts.push(text);
        if (input.startedTexts.length > 1) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "continued", finishReason: "stop" },
            ]),
          );
        }
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            InterfaceProviderStreamEvent,
            void,
            unknown
          > {
            await new Promise<void>((resolve) => {
              if (request.signal?.aborted) {
                resolve();
                return;
              }
              request.signal?.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
            });
            input.abortObserved.resolve(undefined);
            await input.settleAbortedRun;
            yield await Promise.reject<InterfaceProviderStreamEvent>(
              abortError,
            );
          })(),
        );
      },
    },
  };
}

function createPermissionSlotLLMClient(input: {
  readonly onBlockedStarted: () => void;
  readonly releaseBlocked: Promise<undefined>;
}): LLMClientInstance<FakeSdkClient> {
  const client = createFakeLLMClient([]);
  return {
    ...client,
    provider: {
      ...client.provider,
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "Permission wait", finishReason: "stop" },
            ]),
          );
        }
        if (
          lastPersistentRequestMessageText(request) === "permission prompt 1"
        ) {
          return Promise.resolve(
            createProviderStream([
              {
                finishReason: "tool_calls",
                toolCallDeltas: [
                  {
                    argumentsDelta: JSON.stringify({
                      content: "permission one",
                      file_path: "permission-one.txt",
                    }),
                    id: "call_permission_one",
                    index: 0,
                    name: "write",
                  },
                ],
              },
            ]),
          );
        }
        input.onBlockedStarted();
        return Promise.resolve(
          (async function* (): AsyncGenerator<
            InterfaceProviderStreamEvent,
            void,
            unknown
          > {
            await input.releaseBlocked;
            yield { textDelta: "done", finishReason: "stop" };
          })(),
        );
      },
    },
  };
}

function createProviderSubagentControlEvent(input: {
  readonly arguments: Record<string, unknown>;
  readonly callId: string;
  readonly action: "spawn" | "list";
}): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify({
          action: input.action,
          ...input.arguments,
        }),
        id: input.callId,
        index: 0,
        name: "agent",
      },
    ],
  };
}

function waitForPersistentEvent<T extends UiEvent>(
  client: ReturnType<typeof createPersistentUiBackendClient>,
  predicate: (event: UiEvent) => event is T,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsubscribeRef: { current?: () => void } = {};
    const timeout = setTimeout(() => {
      unsubscribeRef.current?.();
      reject(new Error("Timed out waiting for UI event"));
    }, timeoutMs);

    unsubscribeRef.current = client.subscribeEvents((event) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribeRef.current?.();
      resolve(event);
    });
  });
}

function persistentContentToText(content: unknown): string {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

function lastPersistentRequestMessageText(
  request: InterfaceProviderRequest,
): string {
  return persistentContentToText(
    request.messages.findLast(
      (message) =>
        typeof message.content === "string" ||
        !message.content?.some(
          (part) => "source" in part && part.source === "system-reminder",
        ),
    )?.content,
  ).split("\n\n<environment_context>", 1)[0];
}

function allPersistentRequestMessageText(
  request: InterfaceProviderRequest,
): string {
  return JSON.stringify(request.messages);
}

function isPersistentExploreSubagentRequest(
  request: InterfaceProviderRequest,
): boolean {
  return JSON.stringify(request.messages).includes("Task: explore");
}

function createPersistentBackgroundSubagentLLMClient(
  requests: InterfaceProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        if (isPersistentExploreSubagentRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              { textDelta: "background child persisted", finishReason: "stop" },
            ]),
          );
        }
        if (
          lastPersistentRequestMessageText(request).includes(
            "Open persistent background child",
          )
        ) {
          return Promise.resolve(
            createProviderStream([
              createProviderSubagentControlEvent({
                arguments: {
                  description: "Persistent background child",
                  mode: "background",
                  prompt: "Inspect persistent background child files",
                  role: "explore",
                },
                callId: "call_subagent_background",
                action: "spawn",
              }),
            ]),
          );
        }
        return Promise.resolve(
          createProviderStream([
            {
              textDelta: "parent got background subagent",
              finishReason: "stop",
            },
          ]),
        );
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly InterfaceProviderStreamEvent[])[],
  requests: InterfaceProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              {
                textDelta: titleTextForSessionTitleRequest(request),
                finishReason: "stop",
              },
            ]),
          );
        }
        if (nextBatch >= eventBatches.length) {
          return Promise.reject(new Error("No fake LLM response configured"));
        }
        requests.push(request);
        const events = eventBatches[nextBatch];
        nextBatch += 1;
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function isSessionTitleGenerationRequest(
  request: InterfaceProviderRequest,
): boolean {
  return JSON.stringify(request.messages).includes(
    TITLE_GENERATION_PROMPT_MARKER,
  );
}

function titleTextForSessionTitleRequest(
  request: InterfaceProviderRequest,
): string {
  const userMessage = request.messages.find(
    (message) => message.role === "user",
  );
  const content =
    typeof userMessage?.content === "string" ? userMessage.content : "";
  return createTemporarySessionTitle(content);
}

function requireRun(runs: readonly UiRun[], id: string): UiRun {
  const run = runs.find((candidate) => candidate.id === id);
  if (!run) {
    throw new Error(`expected run ${id}`);
  }
  return run;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(directory, "workspace"), { recursive: true });
  return directory;
}

afterEach(() => {
  closeDatabase();
});

describe("createPersistentUiBackendClient", () => {
  it.each(["snapshot", "dispose"] as const)(
    "observes an eager startup rejection before a delayed first %s without hiding its failure",
    async (firstOperation) => {
      const directory = await tempDir("ohbaby-persistent-delayed-startup-");
      const original = uiInProcess.createInProcessUiBackendClient;
      let recovery: Promise<unknown> | undefined;
      const factory = vi
        .spyOn(uiInProcess, "createInProcessUiBackendClient")
        .mockImplementation((options) => {
          recovery =
            options && "startupReady" in options
              ? options.startupReady
              : undefined;
          return original(options);
        });
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      let client: PersistentUiBackendClient | undefined;
      try {
        client = createPersistentUiBackendClient({
          dbPath: join(directory, "agent.db"),
          llmClient: createFakeLLMClient([]),
          resumeSessionId: "missing-delayed-session",
          workdir: join(directory, "workspace"),
        });
        if (!recovery) throw new Error("Missing startup recovery promise");
        // Observe the source promise, leaving the wrapper's derived startup
        // promise unread until Node has had a turn to report orphan rejections.
        await expect(recovery).rejects.toThrow(
          "Session not found: missing-delayed-session",
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        if (firstOperation === "snapshot") {
          await expect(client.getSnapshot()).rejects.toThrow(
            "Session not found: missing-delayed-session",
          );
          await expect(client.dispose()).resolves.toMatchObject({
            status: "confirmed",
            errors: [],
          });
        } else {
          await expect(client.dispose()).resolves.toMatchObject({
            status: "unconfirmed",
            errors: [
              expect.stringContaining(
                "Session not found: missing-delayed-session",
              ),
            ],
          });
        }
      } finally {
        await client?.dispose();
        process.off("unhandledRejection", unhandled);
        factory.mockRestore();
        closeDatabase();
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it("does not hide disposal errors after a reported startup failure", async () => {
    const directory = await tempDir("ohbaby-persistent-dispose-failure-");
    const original = uiInProcess.createInProcessUiBackendClient;
    const factory = vi
      .spyOn(uiInProcess, "createInProcessUiBackendClient")
      .mockImplementation((options) => {
        const backend = original(options);
        return {
          ...backend,
          async dispose(): Promise<never> {
            await backend.dispose();
            throw new Error("fixture disposal failed");
          },
        };
      });
    try {
      const client = createPersistentUiBackendClient({
        dbPath: join(directory, "agent.db"),
        llmClient: createFakeLLMClient([]),
        resumeSessionId: "missing-session",
        workdir: join(directory, "workspace"),
      });
      await expect(client.getSnapshot()).rejects.toThrow("Session not found");
      await expect(client.dispose()).resolves.toMatchObject({
        status: "unconfirmed",
        errors: [expect.stringContaining("fixture disposal failed")],
      });
    } finally {
      factory.mockRestore();
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("runs ten sessions through the real backend and admits the eleventh as queued", async () => {
    const directory = await tempDir("ohbaby-persistent-concurrency-");
    const release = createDeferred<undefined>();
    let started = 0;
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createConcurrentBlockingLLMClient({
        onStarted: () => {
          started += 1;
        },
        release: release.promise,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const receipts: UiPromptReceipt[] = [];
      for (let index = 1; index <= 11; index += 1) {
        receipts.push(
          await client.submitPromptAccepted(`prompt ${String(index)}`, {
            sessionId: `session_concurrent_${String(index)}`,
          }),
        );
      }

      await vi.waitFor(() => {
        expect(started).toBe(10);
      });
      const snapshot = await client.getSnapshot();
      expect(snapshot.prompts).toHaveLength(11);
      expect(
        snapshot.prompts?.find(
          (prompt) => prompt.promptId === receipts[10]?.promptId,
        ),
      ).toMatchObject({ status: "queued" });

      release.resolve(undefined);
      await Promise.all(
        receipts.map((receipt) => client.waitForPrompt(receipt.promptId)),
      );
      expect(started).toBe(11);
    } finally {
      release.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps a real backend session FIFO while queued prompts remain editable and cancellable", async () => {
    const directory = await tempDir("ohbaby-persistent-prompt-fifo-");
    const release = createDeferred<undefined>();
    const startedTexts: string[] = [];
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createConcurrentBlockingLLMClient({
        onStarted: (request) => {
          startedTexts.push(lastPersistentRequestMessageText(request));
        },
        release: release.promise,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const first = await client.submitPromptAccepted("first", {
        sessionId: "session_fifo",
      });
      await vi.waitFor(() => {
        expect(startedTexts).toEqual(["first"]);
      });
      const second = await client.submitPromptAccepted("second", {
        sessionId: "session_fifo",
      });
      const third = await client.submitPromptAccepted("third", {
        sessionId: "session_fifo",
      });
      const snapshot = await client.getSnapshot();
      const queuedSecond = snapshot.prompts?.find(
        (prompt) => prompt.promptId === second.promptId,
      );
      const queuedThird = snapshot.prompts?.find(
        (prompt) => prompt.promptId === third.promptId,
      );
      if (!queuedSecond || !queuedThird) {
        throw new Error("expected queued prompt projections");
      }
      const queuedPromptCount = snapshot.prompts?.length ?? 0;
      expect(queuedSecond.status).toBe("queued");
      const secondLease = await client.acquirePromptEditLease({
        promptId: second.promptId,
      });
      const edited = await client.editQueuedPrompt({
        editLeaseId: secondLease.editLeaseId,
        promptId: second.promptId,
        text: "second edited",
      });
      const cancelled = await client.cancelQueuedPrompt({
        promptId: third.promptId,
      });
      expect(edited.text).toBe("second edited");
      expect(edited.promptId).toBe(second.promptId);
      expect(edited.status).toBe("queued");
      expect(cancelled.status).toBe("cancelled");
      const afterEdit = await client.getSnapshot();
      expect(afterEdit.prompts).toHaveLength(queuedPromptCount);
      expect(
        afterEdit.prompts?.find(
          (prompt) => prompt.promptId === second.promptId,
        ),
      ).toMatchObject({
        promptId: second.promptId,
        status: "queued",
        text: "second edited",
      });

      release.resolve(undefined);
      await Promise.all([
        client.waitForPrompt(first.promptId),
        client.waitForPrompt(second.promptId),
        client.waitForPrompt(third.promptId),
      ]);
      expect(startedTexts).toEqual(["first", "second edited"]);
    } finally {
      release.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps queued same-session text out of the active model context", async () => {
    const directory = await tempDir("ohbaby-persistent-context-isolation-");
    const release = createDeferred<undefined>();
    const requests: InterfaceProviderRequest[] = [];
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createConcurrentBlockingLLMClient({
        onStarted: (request) => {
          requests.push(request);
        },
        release: release.promise,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const first = await client.submitPromptAccepted("active context A only", {
        sessionId: "session_context_isolation",
      });
      await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
      });
      const second = await client.submitPromptAccepted(
        "queued context B must not leak",
        { sessionId: "session_context_isolation" },
      );

      const firstContext = allPersistentRequestMessageText(requests[0]);
      expect(firstContext).toContain("active context A only");
      expect(firstContext).not.toContain("queued context B must not leak");

      release.resolve(undefined);
      await Promise.all([
        client.waitForPrompt(first.promptId),
        client.waitForPrompt(second.promptId),
      ]);
      expect(requests).toHaveLength(2);
      const secondContext = allPersistentRequestMessageText(requests[1]);
      expect(secondContext).toContain("active context A only");
      expect(secondContext).toContain("queued context B must not leak");
    } finally {
      release.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps a permission wait in its active slot and leaves the eleventh queued", async () => {
    const directory = await tempDir("ohbaby-persistent-permission-slots-");
    const releaseBlocked = createDeferred<undefined>();
    let blockedStarted = 0;
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createPermissionSlotLLMClient({
        onBlockedStarted: () => {
          blockedStarted += 1;
        },
        releaseBlocked: releaseBlocked.promise,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const receipts: UiPromptReceipt[] = [];
      for (let index = 1; index <= 11; index += 1) {
        receipts.push(
          await client.submitPromptAccepted(
            `permission prompt ${String(index)}`,
            { sessionId: `session_permission_${String(index)}` },
          ),
        );
      }

      let snapshot = await client.getSnapshot();
      await vi.waitFor(async () => {
        snapshot = await client.getSnapshot();
        expect(snapshot.permissions).toHaveLength(1);
        expect(blockedStarted).toBe(9);
      });
      expect(
        snapshot.prompts?.filter((prompt) => prompt.status === "running"),
      ).toHaveLength(10);
      const eleventh = snapshot.prompts?.find(
        (prompt) => prompt.promptId === receipts[10]?.promptId,
      );
      expect(eleventh).toMatchObject({ status: "queued" });
      if (!eleventh) {
        throw new Error("expected eleventh queued prompt");
      }

      await client.cancelQueuedPrompt({
        promptId: eleventh.promptId,
      });
      const permission = snapshot.permissions[0];
      await client.abortRun(permission.runId);
      releaseBlocked.resolve(undefined);
      await Promise.all(
        receipts.map((receipt) => client.waitForPrompt(receipt.promptId)),
      );
    } finally {
      releaseBlocked.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("binds a normalized provider failure to the accepted prompt", async () => {
    const directory = await tempDir("ohbaby-persistent-prompt-error-");
    const providerError = Object.assign(new Error("provider unauthorized"), {
      status: 401,
    });
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createFailingLLMClient(providerError),
      workdir: join(directory, "workspace"),
    });
    try {
      const receipt = await client.submitPromptAccepted("fail", {
        sessionId: "session_provider_error",
      });
      const completion = await client.waitForPrompt(receipt.promptId);
      expect(completion.prompt).toMatchObject({
        promptId: receipt.promptId,
        status: "failed",
        error: {
          code: "PROVIDER_AUTH",
          message: "LLM provider authentication failed (HTTP 401)",
          retryable: false,
          source: "provider",
          statusCode: 401,
        },
      });
    } finally {
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps one session's provider failure out of another active session's global status", async () => {
    const directory = await tempDir("ohbaby-persistent-prompt-isolation-");
    const release = createDeferred<undefined>();
    const blockedStarted = createDeferred<undefined>();
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createConcurrentMixedOutcomeLLMClient({
        blockedStarted,
        release: release.promise,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const blocked = await client.submitPromptAccepted("keep running", {
        sessionId: "session_running",
      });
      await blockedStarted.promise;
      const failed = await client.submitPromptAccepted("please fail", {
        sessionId: "session_failed",
      });
      await expect(
        client.waitForPrompt(failed.promptId),
      ).resolves.toMatchObject({
        prompt: {
          error: { code: "PROVIDER_AUTH", source: "provider" },
          status: "failed",
        },
      });

      const snapshot = await client.getSnapshot();
      expect(snapshot.status.kind).not.toBe("error");
      expect(
        snapshot.runs.find((run) => run.sessionId === "session_failed")?.status,
      ).toMatchObject({ kind: "error" });

      release.resolve(undefined);
      await client.waitForPrompt(blocked.promptId);
    } finally {
      release.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("aborts one prompt waiter without cancelling the accepted prompt", async () => {
    const directory = await tempDir("ohbaby-persistent-wait-abort-");
    const release = createDeferred<undefined>();
    const startedTexts: string[] = [];
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createAbortableBlockingLLMClient({
        release: release.promise,
        startedTexts,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const receipt = await client.submitPromptAccepted("keep processing", {
        sessionId: "session_wait_abort",
      });
      await vi.waitFor(() => {
        expect(startedTexts).toEqual(["keep processing"]);
      });

      const controller = new AbortController();
      const abortedWait = client.waitForPrompt(receipt.promptId, {
        signal: controller.signal,
      });
      controller.abort();

      await expect(abortedWait).rejects.toMatchObject({
        code: "PROMPT_WAIT_ABORTED",
      });

      release.resolve(undefined);
      await expect(
        client.waitForPrompt(receipt.promptId),
      ).resolves.toMatchObject({
        prompt: { promptId: receipt.promptId, status: "succeeded" },
      });
    } finally {
      release.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("advances the same-session FIFO after the active run is aborted", async () => {
    const directory = await tempDir("ohbaby-persistent-prompt-abort-");
    const release = createDeferred<undefined>();
    const startedTexts: string[] = [];
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createAbortableBlockingLLMClient({
        release: release.promise,
        startedTexts,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const first = await client.submitPromptAccepted("first abortable", {
        sessionId: "session_abort_fifo",
      });
      await vi.waitFor(() => {
        expect(startedTexts).toEqual(["first abortable"]);
      });
      const second = await client.submitPromptAccepted("second after abort", {
        sessionId: "session_abort_fifo",
      });
      const running = (await client.getSnapshot()).prompts?.find(
        (prompt) => prompt.promptId === first.promptId,
      );
      if (!running?.runId) {
        throw new Error("expected active prompt run id");
      }
      await client.abortRun(running.runId);
      await expect(client.waitForPrompt(first.promptId)).resolves.toMatchObject(
        {
          prompt: { status: "interrupted" },
        },
      );
      await vi.waitFor(() => {
        expect(startedTexts).toEqual(["first abortable", "second after abort"]);
      });
      release.resolve(undefined);
      await expect(
        client.waitForPrompt(second.promptId),
      ).resolves.toMatchObject({
        prompt: { status: "succeeded" },
      });
    } finally {
      release.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retains a stopped partial answer in the live view and history after reopening SQLite", async () => {
    const directory = await tempDir("ohbaby-stopped-answer-");
    const fragment = "The first finding";
    const release = createDeferred<undefined>();
    const options = {
      dbPath: join(directory, "agent.db"),
      workdir: join(directory, "workspace"),
      llmClient: createAbortableBlockingLLMClient({
        partialText: fragment,
        release: release.promise,
        startedTexts: [],
      }),
    };
    let client = createPersistentUiBackendClient(options);
    try {
      const { sessionId, promptId } = await client.submitPromptAccepted(
        "Explain your findings",
      );
      const scope = { sessionId };
      const active = await vi.waitFor(async () => {
        const view = await client.getSessionView?.(scope);
        const answer = view?.session.messages.find(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === fragment,
            ),
        );
        if (!answer?.runId)
          throw new Error("Waiting for first answer fragment");
        return { runId: answer.runId, messageId: answer.id };
      });
      await client.abortRun(active.runId);
      await expect(client.waitForPrompt(promptId)).resolves.toMatchObject({
        prompt: { status: "interrupted" },
      });
      async function expectStoppedAnswer(): Promise<void> {
        const view = await client.getSessionView?.(scope);
        const history = await client.getSessionHistory?.(scope);
        if (!view || !history)
          throw new Error("Missing session view or history");
        const run = view.runs.find((item) => item.id === active.runId);
        expect(run).toMatchObject({ outcome: "interrupted", trigger: "user" });
        expect(history.runs).toContainEqual(run);
        for (const messages of [view.session.messages, history.messages]) {
          const answer = messages.find(
            (message) => message.id === active.messageId,
          );
          expect(answer).toMatchObject({
            runId: active.runId,
            status: "error",
          });
          // Pairs with copy improve-2 T8: plain text stays a copyable answer.
          expect(answer).not.toHaveProperty("hiddenToolCalls");
          expect(
            answer?.parts.filter((part) => part.type === "text"),
          ).toMatchObject([
            { text: fragment },
            { metadata: { kind: "lifecycle-interruption" } },
          ]);
        }
      }
      await expectStoppedAnswer();
      await client.dispose();
      closeDatabase();
      client = createPersistentUiBackendClient(options);
      await client.initializeSession(sessionId);
      await expectStoppedAnswer();
    } finally {
      release.resolve(undefined);
      await client.dispose();
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks a progress note whose hidden tool ran before a stop, live and after reopening SQLite (copy improve-2 T8)", async () => {
    const directory = await tempDir("ohbaby-hidden-tool-stop-");
    const note = "I will check the private task list.";
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const nextStepStarted = createDeferred<undefined>();
    const base = createFakeLLMClient([]);
    let steps = 0;
    const llmClient: LLMClientInstance<FakeSdkClient> = {
      ...base,
      provider: {
        ...base.provider,
        isAbortError: (error: unknown): boolean => error === abortError,
        streamResponse(
          request: InterfaceProviderRequest,
        ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
          if (isSessionTitleGenerationRequest(request))
            return Promise.resolve(
              createProviderStream([
                { textDelta: "Hidden tool", finishReason: "stop" },
              ]),
            );
          steps += 1;
          if (steps === 1)
            return Promise.resolve(
              createProviderStream([
                { textDelta: note },
                {
                  finishReason: "tool_calls",
                  toolCallDeltas: [
                    {
                      argumentsDelta: "{}",
                      id: "call_todo_read",
                      index: 0,
                      name: "todo_read",
                    },
                  ],
                },
              ]),
            );
          nextStepStarted.resolve(undefined);
          return Promise.resolve(
            (async function* (): AsyncGenerator<
              InterfaceProviderStreamEvent,
              void,
              unknown
            > {
              // The step after the tool waits until the run is stopped.
              await new Promise<never>((_resolve, reject) => {
                if (request.signal?.aborted) reject(abortError);
                request.signal?.addEventListener(
                  "abort",
                  () => {
                    reject(abortError);
                  },
                  { once: true },
                );
              });
              yield { textDelta: "unreachable", finishReason: "stop" };
            })(),
          );
        },
      },
    };
    const options = {
      dbPath: join(directory, "agent.db"),
      workdir: join(directory, "workspace"),
      llmClient,
    };
    let client = createPersistentUiBackendClient(options);
    try {
      const { sessionId, promptId } =
        await client.submitPromptAccepted("Check the tasks");
      const scope = { sessionId };
      await nextStepStarted.promise;
      const prompt = await vi.waitFor(async () => {
        const found = (await client.getSnapshot()).prompts?.find(
          (item) => item.promptId === promptId,
        );
        if (!found?.runId) throw new Error("Waiting for the run");
        return found;
      });
      const runId = prompt.runId ?? "";
      await client.abortRun(runId);
      await expect(client.waitForPrompt(promptId)).resolves.toMatchObject({
        prompt: { status: "interrupted" },
      });
      async function expectNoteMarked(): Promise<void> {
        const view = await client.getSessionView?.(scope);
        const history = await client.getSessionHistory?.(scope);
        if (!view || !history)
          throw new Error("Missing session view or history");
        for (const messages of [view.session.messages, history.messages]) {
          const owned = messages.filter(
            (message) =>
              message.runId === runId && message.role === "assistant",
          );
          const marked = owned.find((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === note,
            ),
          );
          expect(marked).toMatchObject({ hiddenToolCalls: true });
          expect(
            marked?.parts.some(
              (part) =>
                part.type === "tool-call" || part.type === "tool-result",
            ),
          ).toBe(false);
          // Whatever closes the run, no step after the note has model text,
          // so the note is the only text a client could mistake for an answer.
          const last = owned.at(-1);
          const lastText = last?.parts.some(
            (part) =>
              part.type === "text" &&
              part.text.trim() !== "" &&
              part.metadata?.kind !== "lifecycle-interruption",
          );
          expect(last?.hiddenToolCalls === true || lastText !== true).toBe(
            true,
          );
        }
      }
      await expectNoteMarked();
      await client.dispose();
      closeDatabase();
      client = createPersistentUiBackendClient(options);
      await client.initializeSession(sessionId);
      await expectNoteMarked();
    } finally {
      await client.dispose();
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not advance same-session FIFO until the aborted provider settles", async () => {
    const directory = await tempDir("ohbaby-persistent-abort-barrier-");
    const abortObserved = createDeferred<undefined>();
    const settleAbortedRun = createDeferred<undefined>();
    const startedTexts: string[] = [];
    const client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      llmClient: createDelayedAbortSettlementLLMClient({
        abortObserved,
        settleAbortedRun: settleAbortedRun.promise,
        startedTexts,
      }),
      workdir: join(directory, "workspace"),
    });
    try {
      const first = await client.submitPromptAccepted("first with barrier", {
        sessionId: "session_abort_barrier",
      });
      await vi.waitFor(() => {
        expect(startedTexts).toEqual(["first with barrier"]);
      });
      const second = await client.submitPromptAccepted(
        "second after settled abort",
        { sessionId: "session_abort_barrier" },
      );
      const running = (await client.getSnapshot()).prompts?.find(
        (prompt) => prompt.promptId === first.promptId,
      );
      if (!running?.runId) {
        throw new Error("expected active prompt run id");
      }

      const abort = client.abortRun(running.runId);
      await abortObserved.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startedTexts).toEqual(["first with barrier"]);
      expect(
        (await client.getSnapshot()).prompts?.find(
          (prompt) => prompt.promptId === second.promptId,
        ),
      ).toMatchObject({ status: "queued" });

      settleAbortedRun.resolve(undefined);
      await abort;
      await expect(client.waitForPrompt(first.promptId)).resolves.toMatchObject(
        { prompt: { status: "interrupted" } },
      );
      await expect(
        client.waitForPrompt(second.promptId),
      ).resolves.toMatchObject({ prompt: { status: "succeeded" } });
      expect(startedTexts).toEqual([
        "first with barrier",
        "second after settled abort",
      ]);
    } finally {
      settleAbortedRun.resolve(undefined);
      await client.dispose();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("restores sessions, messages, and runs from the database", async () => {
    const directory = await tempDir("ohbaby-persistent-ui-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      await writeFile(join(directory, "seed.txt"), "seed");

      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Persisted", finishReason: "stop" },
        ]),
        workdir,
      });

      await client.submitPromptAndWait("Remember this");
      const sessionId = (await client.getSnapshot()).activeSessionId;
      const sessionStats = getDatabase()
        .prepare<{
          readonly last_message_at: number | null;
          readonly message_count: number;
        }>(
          `SELECT message_count, last_message_at
           FROM ${schema.session.tableName}
           WHERE id = ?`,
        )
        .get(sessionId ?? "");
      expect(sessionStats).toMatchObject({
        // Session stats count durable core messages, including hidden reminders.
        message_count: 3,
      });
      const storedMessages = getDatabase()
        .prepare<{ id: string; role: string }>(
          `SELECT id, role FROM ${schema.message.tableName} WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(sessionId ?? "");
      expect(sessionStats?.message_count).toBe(storedMessages.length);
      expect(storedMessages.map((message) => message.role)).toEqual([
        "user",
        "user",
        "assistant",
      ]);
      const reminderParts = getDatabase()
        .prepare<{ data: string }>(
          `SELECT data FROM ${schema.part.tableName} WHERE message_id = ? ORDER BY order_index ASC`,
        )
        .all(storedMessages[1].id)
        .map((row) => JSON.parse(row.data) as unknown);
      expect(reminderParts).toMatchObject([
        {
          synthetic: true,
          metadata: {
            kind: "system-reminder:v1",
            reminderType: "environment",
            anchorAssistantId: storedMessages[2].id,
          },
        },
        {
          synthetic: true,
          metadata: {
            kind: "system-reminder:v1",
            reminderType: "mode",
            key: "auto",
            anchorAssistantId: storedMessages[2].id,
          },
        },
      ]);
      expect(sessionStats?.last_message_at).toEqual(expect.any(Number));

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      const snapshot = await restored.getSnapshot();

      expect(snapshot.activeSessionId).toBeNull();
      expect(snapshot.sessions).toHaveLength(1);
      expect(
        snapshot.sessions[0].messages.map((message) => message.role),
      ).toEqual(["user", "assistant"]);
      expect(snapshot.sessions[0].messages[0].parts).toMatchObject([
        { type: "text", text: "Remember this" },
      ]);
      expect(snapshot.sessions[0].messages[1].parts).toMatchObject([
        { type: "text", text: "Persisted" },
      ]);
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0].status).toEqual({ kind: "idle" });
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("resumes after dispose and database close, then restores the continued reply after another reopen", async () => {
    const directory = await tempDir("ohbaby-persistent-migration-reopen-");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");
    let client: PersistentUiBackendClient | undefined;
    try {
      client = createPersistentUiBackendClient({
        dbPath,
        workdir,
        llmClient: createFakeLLMClient([
          { textDelta: "Persisted first reply", finishReason: "stop" },
        ]),
      });
      await client.submitPromptAndWait("Remember this history");
      const sessionId = (await client.getSnapshot()).activeSessionId;
      if (!sessionId) throw new Error("Expected persisted session ID");
      await client.dispose();
      client = undefined;
      closeDatabase();

      const requests: InterfaceProviderRequest[] = [];
      client = createPersistentUiBackendClient({
        dbPath,
        workdir,
        resumeSessionId: sessionId,
        llmClient: createSequentialFakeLLMClient(
          [[{ textDelta: "Persisted continued reply", finishReason: "stop" }]],
          requests,
        ),
      });
      const resumed = await client.getSnapshot();
      expect(resumed.activeSessionId).toBe(sessionId);
      expect(
        resumed.sessions
          .find((session) => session.id === sessionId)
          ?.messages.map((message) => message.role),
      ).toEqual(["user", "assistant"]);
      await client.submitPromptAndWait("Continue this history", { sessionId });
      expect(requests).toHaveLength(1);
      const userMessages = requests[0]?.messages.filter(
        (message) =>
          message.role === "user" &&
          (typeof message.content === "string" ||
            !message.content.some(
              (part) => "source" in part && part.source === "system-reminder",
            )),
      );
      expect(requests[0]?.messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "user",
        "assistant",
        "user",
      ]);
      expect(requests[0]?.messages[2]).toMatchObject({
        content: [
          expect.objectContaining({
            source: "system-reminder",
            text: expect.stringContaining(
              "Current working directory:",
            ) as string,
          }),
          expect.objectContaining({
            source: "system-reminder",
            text: expect.stringContaining("Current mode: auto.") as string,
          }),
        ],
      });
      expect(userMessages).toHaveLength(2);
      expect(userMessages[0].content).toContain("Remember this history");
      expect(userMessages[1].content).toContain("Continue this history");
      expect(requests[0]?.messages).toEqual(
        expect.arrayContaining([
          { role: "assistant", content: "Persisted first reply" },
        ]),
      );
      const readParts = (): { data: string }[] =>
        getDatabase()
          .prepare<{
            data: string;
          }>(
            `SELECT data FROM ${schema.part.tableName} WHERE session_id = ? ORDER BY id`,
          )
          .all(sessionId);
      const storedBeforeClose = readParts();
      expect(
        storedBeforeClose.some((row) => {
          const part = JSON.parse(row.data) as { type?: string; text?: string };
          return (
            part.type === "text" && part.text === "Persisted continued reply"
          );
        }),
      ).toBe(true);
      await client.dispose();
      client = undefined;
      closeDatabase();

      client = createPersistentUiBackendClient({
        dbPath,
        workdir,
        resumeSessionId: sessionId,
        llmClient: createFakeLLMClient([]),
      });
      const reopened = await client.getSnapshot();
      expect(reopened.activeSessionId).toBe(sessionId);
      const transcript = reopened.sessions.find(
        (session) => session.id === sessionId,
      )?.messages;
      expect(transcript?.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(transcript?.at(-1)?.parts).toMatchObject([
        { type: "text", text: "Persisted continued reply" },
      ]);
      expect(readParts()).toEqual(storedBeforeClose);
    } finally {
      await client?.dispose();
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("selects the requested startup resume session before the first snapshot", async () => {
    const directory = await tempDir("ohbaby-persistent-resume-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient(
          [
            [{ textDelta: "First response", finishReason: "stop" }],
            [{ textDelta: "Second response", finishReason: "stop" }],
          ],
          [],
        ),
        workdir,
      });

      await client.submitPromptAndWait("First session");
      const firstSessionId = (await client.getSnapshot()).activeSessionId;
      await client.submitPromptAndWait("Second session");
      const secondSessionId = (await client.getSnapshot()).activeSessionId;

      expect(firstSessionId).toBeTruthy();
      expect(secondSessionId).toBeTruthy();
      expect(secondSessionId).not.toBe(firstSessionId);

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        resumeSessionId: firstSessionId ?? undefined,
        workdir,
      });
      const snapshot = await restored.getSnapshot();

      expect(snapshot.activeSessionId).toBe(firstSessionId);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists goal state through the sqlite-backed persistent client", async () => {
    const directory = await tempDir("ohbaby-persistent-goal-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient([], []),
        workdir,
      });

      await client.executeCommand({
        argv: [],
        clientInvocationId: "inv_new_goal_session",
        commandId: "new",
        path: ["new"],
        raw: "/new",
        rawArgs: "",
        surface: "tui",
      });
      const sessionId = (await client.getSnapshot()).activeSessionId;
      expect(sessionId).toBeTruthy();

      const paused = waitForPersistentEvent(
        client,
        (event): event is Extract<UiEvent, { type: "notice.emitted" }> =>
          event.type === "notice.emitted" &&
          event.notice.source === "goals" &&
          event.notice.message.includes("runtime error"),
      );
      await client.executeCommand({
        argv: ["persist", "this", "goal"],
        clientInvocationId: "inv_goal_persist",
        commandId: "goal",
        path: ["goal"],
        raw: "/goal persist this goal",
        rawArgs: "persist this goal",
        sessionId: sessionId ?? undefined,
        surface: "tui",
      });
      await paused;
      if (!sessionId) throw new Error("Goal session was not created");
      const beforeRestart = await client.getSessionView?.({ sessionId });
      if (!beforeRestart) throw new Error("Goal session view is unavailable");
      expect(
        beforeRestart.session.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => message.parts),
      ).toMatchObject([{ type: "text", text: "persist this goal" }]);
      expect(beforeRestart.goal).toMatchObject({
        status: "ready",
        value: { status: "paused", turnsUsed: 1 },
      });
      await client.dispose();
      closeDatabase();

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient([], []),
        workdir,
      });
      const events: UiEvent[] = [];
      restored.subscribeEvents((event) => {
        events.push(event);
      });
      await restored.executeCommand({
        argv: ["status"],
        clientInvocationId: "inv_goal_status_restored",
        commandId: "goal",
        path: ["goal"],
        raw: "/goal status",
        rawArgs: "status",
        sessionId,
        surface: "tui",
      });

      const output = events.find(
        (
          event,
        ): event is Extract<UiEvent, { type: "command.result.delivered" }> =>
          event.type === "command.result.delivered" &&
          event.clientInvocationId === "inv_goal_status_restored" &&
          event.output?.kind === "text",
      )?.output;
      expect(output?.kind).toBe("text");
      const text = output?.kind === "text" ? output.text : "";
      expect(text).toContain("persist this goal");
      expect(text).toContain("paused");
      const afterRestart = await restored.getSessionView?.({ sessionId });
      if (!afterRestart)
        throw new Error("Restored goal session view is unavailable");
      expect(afterRestart.goal).toEqual(beforeRestart.goal);
      expect(
        afterRestart.session.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => message.parts),
      ).toMatchObject([{ type: "text", text: "persist this goal" }]);
      await restored.dispose();
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects startup resume sessions from another project root", async () => {
    const directory = await tempDir("ohbaby-persistent-resume-scope-");
    try {
      const dbPath = join(directory, "agent.db");
      const currentWorkdir = join(directory, "workspace-current");
      const otherWorkdir = join(directory, "workspace-other");
      await mkdir(currentWorkdir, { recursive: true });
      await mkdir(otherWorkdir, { recursive: true });
      const otherClient = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Other response", finishReason: "stop" },
        ]),
        now: () => new Date(10_000),
        workdir: otherWorkdir,
      });

      await otherClient.submitPromptAndWait("Other project session");
      const otherSessionId = (await otherClient.getSnapshot()).activeSessionId;
      expect(otherSessionId).toBeTruthy();
      await otherClient.dispose();
      closeDatabase();

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        resumeSessionId: otherSessionId ?? undefined,
        workdir: currentWorkdir,
      });

      await expect(restored.getSnapshot()).rejects.toThrow(
        /current project|Session not found/u,
      );
      await restored.dispose();
      const unread = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        resumeSessionId: otherSessionId ?? undefined,
        workdir: currentWorkdir,
      });
      // Disposal drains startup and must not hide an unobserved failure.
      await expect(unread.dispose()).resolves.toMatchObject({
        status: "unconfirmed",
        errors: [expect.stringMatching(/current project|Session not found/u)],
      });
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps simultaneous project roots isolated while sharing one sqlite database", async () => {
    const directory = await tempDir("ohbaby-persistent-sqlite-scope-");
    try {
      const dbPath = join(directory, "agent.db");
      const projectA = join(directory, "project-a");
      const projectB = join(directory, "project-b");
      await mkdir(projectA, { recursive: true });
      await mkdir(projectB, { recursive: true });
      const clientA = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Project A response", finishReason: "stop" },
        ]),
        now: () => new Date(1_000),
        workdir: projectA,
      });
      const clientB = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Project B response", finishReason: "stop" },
        ]),
        now: () => new Date(2_000),
        workdir: projectB,
      });

      await clientA.submitPromptAndWait("Prompt for project A");
      await clientB.submitPromptAndWait("Prompt for project B");

      const snapshotA = await clientA.getSnapshot();
      const snapshotB = await clientB.getSnapshot();
      const serializedA = JSON.stringify(snapshotA);
      const serializedB = JSON.stringify(snapshotB);

      expect(snapshotA.activeSessionId).toBeTruthy();
      expect(snapshotB.activeSessionId).toBeTruthy();
      expect(snapshotA.activeSessionId).not.toBe(snapshotB.activeSessionId);
      expect(serializedA).toContain("Prompt for project A");
      expect(serializedA).not.toContain("Prompt for project B");
      expect(serializedB).toContain("Prompt for project B");
      expect(serializedB).not.toContain("Prompt for project A");

      await clientA.dispose();
      await clientB.dispose();
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("selects the latest primary session for explicit continue startup", async () => {
    const directory = await tempDir("ohbaby-persistent-continue-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient(
          [
            [{ textDelta: "First response", finishReason: "stop" }],
            [{ textDelta: "Second response", finishReason: "stop" }],
          ],
          [],
        ),
        workdir,
      });

      await client.submitPromptAndWait("First session");
      const firstSessionId = (await client.getSnapshot()).activeSessionId;
      await client.submitPromptAndWait("Second session");
      const secondSessionId = (await client.getSnapshot()).activeSessionId;

      expect(firstSessionId).toBeTruthy();
      expect(secondSessionId).toBeTruthy();
      expect(secondSessionId).not.toBe(firstSessionId);

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        startupSessionMode: { type: "continue" },
        workdir,
      });
      const snapshot = await restored.getSnapshot();

      expect(snapshot.activeSessionId).toBe(secondSessionId);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("selects the latest current-project session for explicit continue startup", async () => {
    const directory = await tempDir("ohbaby-persistent-continue-scope-");
    try {
      const dbPath = join(directory, "agent.db");
      const currentWorkdir = join(directory, "workspace-current");
      const otherWorkdir = join(directory, "workspace-other");
      await mkdir(currentWorkdir, { recursive: true });
      await mkdir(otherWorkdir, { recursive: true });
      const currentClient = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Current response", finishReason: "stop" },
        ]),
        now: () => new Date(1_000),
        workdir: currentWorkdir,
      });

      await currentClient.submitPromptAndWait("Current project session");
      const currentSessionId = (await currentClient.getSnapshot())
        .activeSessionId;
      expect(currentSessionId).toBeTruthy();
      await currentClient.dispose();
      closeDatabase();

      const otherClient = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Other response", finishReason: "stop" },
        ]),
        now: () => new Date(10_000),
        workdir: otherWorkdir,
      });

      await otherClient.submitPromptAndWait("Other project session");
      const otherSessionId = (await otherClient.getSnapshot()).activeSessionId;
      expect(otherSessionId).toBeTruthy();
      expect(otherSessionId).not.toBe(currentSessionId);
      await otherClient.dispose();
      closeDatabase();

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        startupSessionMode: { type: "continue" },
        workdir: currentWorkdir,
      });
      const snapshot = await restored.getSnapshot();
      const serializedSnapshot = JSON.stringify(snapshot);

      expect(snapshot.activeSessionId).toBe(currentSessionId);
      expect(serializedSnapshot).toContain("Current project session");
      expect(serializedSnapshot).not.toContain("Other project session");
      await restored.dispose();
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("skips sessions marked as subagents during explicit continue startup", async () => {
    const directory = await tempDir("ohbaby-persistent-continue-subagent-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient(
          [[{ textDelta: "Primary response", finishReason: "stop" }]],
          [],
        ),
        workdir,
      });

      await client.submitPromptAndWait("Primary session");
      const primarySessionId = (await client.getSnapshot()).activeSessionId;
      if (!primarySessionId) {
        throw new Error("expected primary session");
      }
      const now = Date.now() + 1_000;
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.session.tableName}
           (id, project_id, working_directory, agent, parent_id, title, status, created_at, updated_at, message_count, last_message_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "session_legacy_subagent",
          "global",
          workdir,
          "explore",
          null,
          "Legacy subagent",
          "active",
          now,
          now,
          1,
          now,
          JSON.stringify({ isSubagent: true }),
        );

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        startupSessionMode: { type: "continue" },
        workdir,
      });
      const snapshot = await restored.getSnapshot();

      expect(snapshot.activeSessionId).toBe(primarySessionId);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not create an empty session during fresh startup", async () => {
    const directory = await tempDir("ohbaby-persistent-empty-startup-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });

      const snapshot = await client.getSnapshot();
      const sessionCount = getDatabase()
        .prepare<{
          readonly count: number;
        }>(`SELECT COUNT(*) as count FROM ${schema.session.tableName}`)
        .get()?.count;

      expect(snapshot.activeSessionId).toBeNull();
      expect(snapshot.sessions).toEqual([]);
      expect(sessionCount).toBe(0);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails the first snapshot when the requested startup resume session is missing", async () => {
    const directory = await tempDir("ohbaby-persistent-resume-missing-");
    let client: PersistentUiBackendClient | undefined;
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      await client.initialize();
      await client.dispose();
      client = undefined;

      client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        resumeSessionId: "missing",
        workdir,
      });

      await expect(client.getSnapshot()).rejects.toThrow(
        "Session not found: missing",
      );
    } finally {
      await client?.dispose();
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["user", "goal"] as const)(
    "persists the %s run and its child-result wakeup with their distinct triggers",
    async (owner) => {
      const directory = await tempDir("ohbaby-trigger-");
      const releaseChild = createDeferred<undefined>();
      const releaseWake = createDeferred<undefined>();
      const llm = createFakeLLMClient([
        { textDelta: "done", finishReason: "stop" },
      ]);
      const fallback = llm.provider.streamResponse.bind(llm.provider);
      const wakeTodos = [
        { content: "Review the child result", status: "completed" },
      ];
      let primaryRequests = 0;
      vi.spyOn(llm.provider, "streamResponse").mockImplementation(
        async (request) => {
          if (isSessionTitleGenerationRequest(request))
            return fallback(request);
          if (isPersistentExploreSubagentRequest(request)) {
            await releaseChild.promise;
            return createProviderStream([
              { textDelta: "child result", finishReason: "stop" },
            ]);
          }
          primaryRequests++;
          if (primaryRequests === 1)
            return createProviderStream([
              createProviderSubagentControlEvent({
                callId: "spawn",
                action: "spawn",
                arguments: { prompt: "inspect files", role: "explore" },
              }),
            ]);
          if (primaryRequests === 3) {
            await releaseWake.promise;
            return createProviderStream([
              {
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "record-result",
                    name: "todo_write",
                    argumentsDelta: JSON.stringify({ todos: wakeTodos }),
                  },
                ],
                finishReason: "tool_calls",
              },
            ]);
          }
          if (primaryRequests === 4 && owner === "goal") {
            return createProviderStream([
              {
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "finish-goal",
                    name: "UpdateGoal",
                    argumentsDelta: JSON.stringify({ status: "complete" }),
                  },
                ],
                finishReason: "tool_calls",
              },
            ]);
          }
          return fallback(request);
        },
      );
      const client = createPersistentUiBackendClient({
        dbPath: join(directory, "agent.db"),
        workdir: join(directory, "workspace"),
        llmClient: llm,
      });
      const updates: UiRun[] = [];
      client.subscribeEvents((event) => {
        if (event.type === "run.updated") updates.push(event.run);
      });
      try {
        const { id: sessionId } = await client.createSession();
        if (owner === "goal")
          await client.executeCommand({
            sessionId,
            commandId: "goal",
            path: ["goal"],
            argv: ["inspect files"],
            raw: "/goal inspect files",
            rawArgs: "inspect files",
            surface: "tui",
            clientInvocationId: "goal",
          });
        else await client.submitPromptAndWait("inspect files", { sessionId });
        const ledger = createDatabaseRunLedger();
        await vi.waitFor(async () => {
          expect(
            await ledger.listBySession(sessionId, { mainOnly: true }),
          ).toMatchObject([{ triggerSource: owner, status: "succeeded" }]);
        });
        releaseChild.resolve(undefined);
        await vi.waitFor(() => {
          expect(primaryRequests).toBe(3);
        });
        expect((await client.getSessionControl?.({ sessionId }))?.driver).toBe(
          owner === "goal" ? "goal" : "subagent",
        );
        releaseWake.resolve(undefined);
        await vi.waitFor(async () => {
          const runs = await ledger.listBySession(sessionId, {
            mainOnly: true,
          });
          expect(runs).toMatchObject([
            { triggerSource: "subagent", status: "succeeded" },
            { triggerSource: owner, status: "succeeded" },
          ]);
          const view = await client.getSessionView?.({ sessionId });
          for (const run of runs) {
            const expected = {
              id: run.runId,
              trigger: run.triggerSource,
              outcome: "succeeded",
            };
            expect(view?.runs).toContainEqual(
              expect.objectContaining(expected),
            );
            expect(updates).toContainEqual(expect.objectContaining(expected));
          }
        });
        const messages = await createDatabaseMessageStore().listBySession(
          sessionId,
          { contextScopeId: undefined },
        );
        const ordinaryTodos = recoverTodosFromMessages(messages);
        if (owner === "goal") {
          const [goal] =
            await createSqliteGoalPersistence(getDatabase()).list(sessionId);
          expect(
            recoverTodosFromMessages(
              messages,
              undefined,
              goalTodoWorkScopeId(goal.goalId),
            ),
          ).toEqual(wakeTodos);
          expect(ordinaryTodos).toEqual([]);
        } else {
          expect(ordinaryTodos).toEqual(wakeTodos);
        }
      } finally {
        releaseChild.resolve(undefined);
        releaseWake.resolve(undefined);
        await client.dispose();
        closeDatabase();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("persists background subagent child sessions, transcripts, and run ledger entries", async () => {
    const directory = await tempDir("ohbaby-persistent-background-subagent-");
    let client: PersistentUiBackendClient | undefined;
    let restored: PersistentUiBackendClient | undefined;
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const requests: InterfaceProviderRequest[] = [];
      client = createPersistentUiBackendClient({
        createSubagentId: () => "subagent_persistent_1",
        dbPath,
        llmClient: createPersistentBackgroundSubagentLLMClient(requests),
        workdir,
      });

      await client.submitPromptAndWait("Open persistent background child");
      const parentSessionId = (await client.getSnapshot()).activeSessionId;
      if (!parentSessionId) {
        throw new Error("expected parent session");
      }

      await vi.waitUntil(() => {
        const rows = getDatabase()
          .prepare(
            `SELECT id
             FROM ${schema.session.tableName}
             WHERE parent_id = ?`,
          )
          .all(parentSessionId);
        return rows.length === 1;
      });
      const childRows = getDatabase()
        .prepare<{
          readonly id: string;
          readonly agent: string | null;
          readonly data: string;
          readonly parent_id: string | null;
        }>(
          `SELECT id, agent, parent_id, data
           FROM ${schema.session.tableName}
           WHERE parent_id = ?`,
        )
        .all(parentSessionId);
      const childId = childRows[0].id;
      expect(childRows[0]).toMatchObject({
        agent: "explore",
        parent_id: parentSessionId,
      });
      expect(JSON.parse(childRows[0].data)).toMatchObject({
        isSubagent: true,
      });

      await vi.waitUntil(() => {
        const rows = getDatabase()
          .prepare<{ readonly status: string }>(
            `SELECT status
             FROM ${schema.runLedger.tableName}
             WHERE session_id = ?`,
          )
          .all(childId);
        return rows.some((row) => row.status === "succeeded");
      });
      const childRuns = getDatabase()
        .prepare<{
          readonly run_id: string;
          readonly status: string;
        }>(
          `SELECT run_id, status
           FROM ${schema.runLedger.tableName}
           WHERE session_id = ?`,
        )
        .all(childId);
      expect(childRuns).toEqual([
        expect.objectContaining({ status: "succeeded" }),
      ]);

      const executions = await client.listSubagentExecutions({
        rootSessionId: parentSessionId,
      });
      expect(executions.executions).toHaveLength(1);
      const execution = executions.executions[0];
      const executionStore = new DatabaseSubagentExecutionStore();
      await vi.waitFor(async () => {
        expect(
          await executionStore.getForRoot(
            execution.executionId,
            parentSessionId,
          ),
        ).toMatchObject({
          status: "completed",
          delivery: { state: "processed" },
        });
      });
      await client.dispose();
      client = undefined;
      closeDatabase();

      restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      const restoredSnapshot = await restored.getSnapshot();
      expect(
        restoredSnapshot.sessions.some((session) => session.id === childId),
      ).toBe(false);
      await expect(
        restored.submitPromptAndWait("Should not run as primary", {
          sessionId: childId,
        }),
      ).rejects.toThrow("Cannot submit a primary prompt to subagent session");

      const childMessages = getDatabase()
        .prepare<{ readonly id: string; readonly role: string }>(
          `SELECT id, role
           FROM ${schema.message.tableName}
           WHERE session_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(childId);
      expect(childMessages.map((message) => message.role)).toEqual([
        "user",
        "user",
        "assistant",
      ]);
      const childParts = getDatabase()
        .prepare<{ readonly data: string }>(
          `SELECT data
           FROM ${schema.part.tableName}
           WHERE session_id = ?
           ORDER BY created_at ASC, order_index ASC`,
        )
        .all(childId);
      const childReminderParts = childParts
        .map(
          (row) =>
            JSON.parse(row.data) as {
              synthetic?: boolean;
              metadata?: {
                kind?: string;
                reminderType?: string;
                anchorAssistantId?: string;
              };
            },
        )
        .filter((part) => part.metadata?.kind === "system-reminder:v1");
      expect(childReminderParts).toHaveLength(1);
      expect(childReminderParts).toMatchObject([
        {
          synthetic: true,
          metadata: {
            reminderType: "environment",
            anchorAssistantId: childMessages[2].id,
          },
        },
      ]);
      const childTranscript = JSON.stringify(childParts);
      expect(childTranscript).toContain(
        "Inspect persistent background child files",
      );
      expect(childTranscript).toContain("background child persisted");

      const view = await restored.getSubagentExecutionView({
        rootSessionId: parentSessionId,
        executionId: execution.executionId,
      });
      expect(view.readOnly).toBe(true);
      expect(view.output).toBe("background child persisted");
      const conversation = await restored.getSubagentConversationView({
        rootSessionId: parentSessionId,
        subagentId: execution.subagentId,
        anchorExecutionId: execution.executionId,
      });
      expect(conversation.readOnly).toBe(true);
      expect(conversation.anchorFound).toBe(true);
      expect(conversation.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(JSON.stringify(conversation.messages)).toContain(
        "background child persisted",
      );

      const parentParts = getDatabase()
        .prepare<{ readonly data: string }>(
          `SELECT data
           FROM ${schema.part.tableName}
           WHERE session_id = ?
           ORDER BY created_at ASC, order_index ASC`,
        )
        .all(parentSessionId);
      const parentTranscript = JSON.stringify(parentParts);
      expect(parentTranscript).toContain("subagent_persistent_1");
      expect(parentTranscript).toContain("background child persisted");
    } finally {
      await restored?.dispose();
      await client?.dispose();
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("closes unfinished executions of terminal roots on SQLite reopen without replaying completed results", async () => {
    const directory = await tempDir("ohbaby-execution-recovery-");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");
    let client: PersistentUiBackendClient | undefined;
    try {
      client = createPersistentUiBackendClient({
        dbPath,
        workdir,
        llmClient: createFakeLLMClient([
          { textDelta: "seed", finishReason: "stop" },
        ]),
      });
      await client.submitPromptAndWait("seed");
      const sessionId = (await client.getSnapshot()).activeSessionId;
      if (!sessionId) throw new Error("expected seed session");
      await client.dispose();
      client = undefined;
      const ledger = createDatabaseRunLedger({
        ownerId: "dead-owner",
        ownerPid: 2147483647,
      });
      await ledger.createPending({
        runId: "orphan-root",
        sessionId,
        triggerSource: "user",
      });
      await ledger.markRunning("orphan-root");
      const store = new DatabaseSubagentExecutionStore();
      for (const id of ["queued", "running", "completed"]) {
        const lookup = {
          executionId: id,
          parentSessionId: sessionId,
          requesterScopeId: "primary",
        };
        await store.accept({
          ...lookup,
          requestId: id,
          requesterRunId: "orphan-root",
          rootRunId: "orphan-root",
          rootSessionId: sessionId,
          subagentId: id,
          mode: "background",
          prompt: "never replay",
          timeoutMs: 1000,
          createdAt: 1,
        });
        if (id !== "queued") {
          await store.bindChild(
            lookup,
            { sessionId: "child-" + id, contextScopeId: "child" },
            2,
          );
          // The recovery contract validates the full child Run identity.
          getDatabase()
            .prepare(
              `INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) SELECT ?,project_id,working_directory,'child','active',1,1,'{}' FROM session WHERE id=?`,
            )
            .run("child-" + id, sessionId);
          await ledger.createPending({
            runId: "child-run-" + id,
            sessionId: "child-" + id,
            contextScopeId: "child",
            triggerSource: "user",
          });
          await ledger.markRunning("child-run-" + id);
          if (id === "completed") await ledger.markSucceeded("child-run-" + id);
          await store.start(lookup, "child-run-" + id, 3);
        }
        if (id === "completed")
          await store.finish(lookup, {
            status: "completed",
            output: "complete original output",
            completedAt: 4,
          });
      }
      const completed = await store.getForRoot("completed", sessionId);
      for (const root of ["live-root", "ended-root"]) {
        await ledger.createPending({
          runId: root,
          sessionId,
          triggerSource: "user",
          ownerId: "live-owner",
          ownerPid: process.pid,
        });
        await ledger.markRunning(root);
        if (root === "ended-root") await ledger.markSucceeded(root);
        await store.accept({
          executionId: root,
          requestId: root,
          parentSessionId: sessionId,
          requesterScopeId: "primary",
          requesterRunId: root,
          rootRunId: root,
          rootSessionId: sessionId,
          subagentId: root,
          mode: "background",
          prompt: "never replay",
          timeoutMs: 1000,
          createdAt: 1,
        });
      }
      closeDatabase();
      const llm = createFakeLLMClient([]);
      const requests = vi.spyOn(llm.provider, "streamResponse");
      client = createPersistentUiBackendClient({
        dbPath,
        workdir,
        llmClient: llm,
      });
      await client.getSnapshot();
      const reopened = new DatabaseSubagentExecutionStore();
      for (const id of ["queued", "running"])
        expect(await reopened.getForRoot(id, sessionId)).toMatchObject({
          status: "interrupted",
        });
      expect(await reopened.getForRoot("completed", sessionId)).toEqual(
        completed,
      );
      expect(await reopened.getForRoot("ended-root", sessionId)).toMatchObject({
        status: "queued",
      });
      expect(await reopened.getForRoot("live-root", sessionId)).toMatchObject({
        status: "queued",
      });
      const recovered = await reopened.listByRootRun("orphan-root");
      await client.initializeSession(sessionId);
      expect(await reopened.listByRootRun("orphan-root")).toEqual(recovered);
      expect(await reopened.listByRootRun("orphan-root")).toHaveLength(3);
      expect(requests).not.toHaveBeenCalled();
      expect(
        getDatabase()
          .prepare<{
            count: number;
          }>(
            `SELECT COUNT(*) AS count FROM ${schema.currentRunInput.tableName}`,
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      await client?.dispose();
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("marks orphaned pending and running runs interrupted before restoring the first snapshot", async () => {
    const directory = await tempDir("ohbaby-persistent-recovery-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Seeded", finishReason: "stop" },
        ]),
        workdir,
      });

      await client.submitPromptAndWait("Seed session");
      const seededSnapshot = await client.getSnapshot();
      const sessionId = seededSnapshot.activeSessionId;
      if (!sessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const runLedger = createDatabaseRunLedger({
        now: () => 42_000,
        ownerId: "dead-owner",
        ownerPid: 2147483647,
      });
      await runLedger.createPending({
        runId: "run_stale_pending",
        sessionId,
        triggerSource: "user",
      });
      await runLedger.createPending({
        runId: "run_stale_running",
        sessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_stale_running");
      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      const snapshot = await restored.getSnapshot();
      const stalePending = requireRun(snapshot.runs, "run_stale_pending");
      const staleRunning = requireRun(snapshot.runs, "run_stale_running");

      expect(snapshot.status).toEqual({ kind: "idle" });
      expect(stalePending.status.kind).toBe("error");
      expect(
        stalePending.status.kind === "error" ? stalePending.status.message : "",
      ).toContain("interrupted");
      expect(staleRunning.status.kind).toBe("error");
      expect(
        staleRunning.status.kind === "error" ? staleRunning.status.message : "",
      ).toContain("interrupted");
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves online ownerless runs and blocks execution until ownership can be established", async () => {
    const directory = await tempDir("ohbaby-persistent-daemon-recovery-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Seeded", finishReason: "stop" },
        ]),
        workdir,
      });

      await client.submitPromptAndWait("Seed session");
      const sessionId = (await client.getSnapshot()).activeSessionId;
      if (!sessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const runLedger = createDatabaseRunLedger({ now: () => 42_000 });
      await runLedger.createPending({
        runId: "run_daemon_stale",
        sessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_daemon_stale");
      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      const snapshot = await restored.getSnapshot();
      const staleRun = requireRun(snapshot.runs, "run_daemon_stale");

      expect(staleRun.status.kind).toBe("running");
      await expect(
        restored.submitPromptAccepted("must not run", { sessionId }),
      ).rejects.toThrow(/owner/);
      expect((await runLedger.get("run_daemon_stale"))?.status).toBe("running");
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not interrupt active runs when another live backend owns the database", async () => {
    const directory = await tempDir("ohbaby-persistent-live-owner-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Seeded", finishReason: "stop" },
        ]),
        workdir,
      });

      await client.submitPromptAndWait("Seed session");
      const seededSnapshot = await client.getSnapshot();
      const sessionId = seededSnapshot.activeSessionId;
      if (!sessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const runLedger = createDatabaseRunLedger({
        now: () => 42_000,
        ownerId: "backend_live_owner",
        ownerPid: process.pid,
      });
      await runLedger.createPending({
        runId: "run_live_pending",
        sessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_live_pending");

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        startupSessionMode: { type: "continue" },
        workdir,
      });
      const snapshot = await restored.getSnapshot();
      const liveRun = requireRun(snapshot.runs, "run_live_pending");

      expect(liveRun.status).toEqual({
        kind: "running",
        runId: "run_live_pending",
      });
      expect(snapshot.status).toEqual({
        kind: "running",
        runId: "run_live_pending",
      });
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not recover another live backend's active run when an idle backend starts", async () => {
    const directory = await tempDir("ohbaby-persistent-live-owner-steal-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const owner = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Seeded", finishReason: "stop" },
        ]),
        workdir,
      });

      await owner.submitPromptAndWait("Seed session");
      const seededSnapshot = await owner.getSnapshot();
      const sessionId = seededSnapshot.activeSessionId;
      if (!sessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }
      const runLedger = createDatabaseRunLedger({
        now: () => 42_000,
        ownerId: "backend_live_owner",
        ownerPid: process.pid,
      });
      await runLedger.createPending({
        runId: "run_live_owner",
        sessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_live_owner");

      const idleBackend = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      await idleBackend.getSnapshot();
      await idleBackend.dispose();

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        startupSessionMode: { type: "continue" },
        workdir,
      });
      const restoredSnapshot = await restored.getSnapshot();
      const liveRun = requireRun(restoredSnapshot.runs, "run_live_owner");

      expect(liveRun.status).toEqual({
        kind: "running",
        runId: "run_live_owner",
      });
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("lets another backend submit a fresh session while a different session is running", async () => {
    const directory = await tempDir("ohbaby-persistent-multiwindow-");
    const firstStarted = createDeferred<undefined>();
    const releaseFirst = createDeferred<undefined>();
    let firstBackend:
      | ReturnType<typeof createPersistentUiBackendClient>
      | undefined;
    let secondBackend:
      | ReturnType<typeof createPersistentUiBackendClient>
      | undefined;
    let firstRun:
      | ReturnType<PersistentUiBackendClient["submitPromptAndWait"]>
      | undefined;
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      firstBackend = createPersistentUiBackendClient({
        dbPath,
        llmClient: createBlockingLLMClient({
          release: releaseFirst.promise,
          started: firstStarted,
          text: "First backend completed",
        }),
        workdir,
      });
      secondBackend = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Second backend completed", finishReason: "stop" },
        ]),
        workdir,
      });

      firstRun = firstBackend.submitPromptAndWait("Keep first window running");
      await withTimeout(
        firstStarted.promise,
        1_000,
        "first backend did not start running",
      );

      await expect(
        withTimeout(
          secondBackend.submitPromptAndWait("Run in another fresh window"),
          1_000,
          "second backend was blocked by another session's active run",
        ),
      ).resolves.toMatchObject({ prompt: { status: "succeeded" } });

      const secondSnapshot = await secondBackend.getSnapshot();
      expect(secondSnapshot.activeSessionId).toBeDefined();
      expect(
        secondSnapshot.sessions.some((session) =>
          session.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "text" &&
                part.text === "Run in another fresh window",
            ),
          ),
        ),
      ).toBe(true);

      releaseFirst.resolve(undefined);
      await firstRun;
      await firstBackend.dispose();
      await secondBackend.dispose();
    } finally {
      await secondBackend?.dispose();
      releaseFirst.resolve(undefined);
      await firstRun?.catch(() => undefined);
      await firstBackend?.dispose();
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("queues a same-session prompt while a live owner run is active", async () => {
    const directory = await tempDir("ohbaby-persistent-session-queue-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const owner = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Seeded", finishReason: "stop" },
        ]),
        workdir,
      });

      await owner.submitPromptAndWait("Seed session");
      const ownerSnapshot = await owner.getSnapshot();
      const ownerSessionId = ownerSnapshot.activeSessionId;
      if (!ownerSessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const runLedger = createDatabaseRunLedger({
        now: () => 42_000,
        ownerId: "backend_live_owner",
        ownerPid: process.pid,
      });
      await runLedger.createPending({
        runId: "run_owner_active",
        sessionId: ownerSessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_owner_active");

      const contender = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Queued response", finishReason: "stop" },
        ]),
        workdir,
      });
      const queuedPrompt = contender.submitPromptAndWait("Run after owner", {
        sessionId: ownerSessionId,
      });
      const earlyResult = await Promise.race([
        queuedPrompt.then(() => "resolved"),
        new Promise<"pending">((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 80);
        }),
      ]);

      expect(earlyResult).toBe("pending");

      await runLedger.markRunInterrupted("run_owner_active", "user-stop");
      await withTimeout(
        queuedPrompt,
        1_000,
        "same-session prompt did not resume after the active run finished",
      );

      const contenderSnapshot = await contender.getSnapshot();
      expect(contenderSnapshot.activeSessionId).toBe(ownerSessionId);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("recovers a dead-owner same-session run before submitting a prompt", async () => {
    const directory = await tempDir("ohbaby-persistent-owner-dead-submit-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const owner = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Seeded", finishReason: "stop" },
        ]),
        workdir,
      });

      await owner.submitPromptAndWait("Seed session");
      const ownerSnapshot = await owner.getSnapshot();
      const ownerSessionId = ownerSnapshot.activeSessionId;
      if (!ownerSessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const exitedOwner = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(exitedOwner, "exit");
      if (!exitedOwner.pid) throw new Error("Missing exited fixture owner PID");
      let observation: unknown;
      try {
        process.kill(exitedOwner.pid, 0);
      } catch (error) {
        observation = error;
      }
      expect(observation).toMatchObject({ code: "ESRCH" });
      const runLedger = createDatabaseRunLedger({
        now: () => 42_000,
        ownerId: "backend_dead_owner",
        ownerPid: exitedOwner.pid,
      });
      await runLedger.createPending({
        runId: "run_owner_stale",
        sessionId: ownerSessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_owner_stale");

      const contender = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([
          { textDelta: "Recovered response", finishReason: "stop" },
        ]),
        workdir,
      });
      await expect(
        withTimeout(
          contender.submitPromptAndWait("Run after owner death", {
            sessionId: ownerSessionId,
          }),
          1_000,
          "dead-owner prompt was not recovered before submission",
        ),
      ).resolves.toMatchObject({ prompt: { status: "succeeded" } });

      const contenderSnapshot = await contender.getSnapshot();
      const staleRun = requireRun(contenderSnapshot.runs, "run_owner_stale");
      expect(contenderSnapshot.activeSessionId).toBe(ownerSessionId);
      expect(staleRun.status.kind).toBe("error");
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not attach snapshot hooks unless explicitly enabled", async () => {
    const directory = await tempDir("ohbaby-persistent-no-snapshot-");
    try {
      const track = vi.fn(() =>
        Promise.reject(new Error("snapshot should be off")),
      );
      const capture = vi.fn(() =>
        Promise.reject(new Error("snapshot should be off")),
      );
      const snapshotService = {
        capture,
        track,
      } as unknown as SnapshotService;

      const client = createPersistentUiBackendClient({
        dbPath: join(directory, "agent.db"),
        llmClient: createFakeLLMClient([
          { textDelta: "No snapshot", finishReason: "stop" },
        ]),
        snapshotService,
        workdir: directory,
      });

      await client.submitPromptAndWait("Run without snapshot");

      expect(track).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("runs enabled snapshot hooks even when an earlier observer hook fails", async () => {
    const directory = await tempDir("ohbaby-persistent-snapshot-hooks-");
    try {
      const track = vi.fn(() =>
        Promise.resolve({
          checkpointId: "checkpoint_1",
          createdAt: 1,
          preTreeRef: "a".repeat(40),
          sessionId: "session_1",
          turnId: "turn_1",
          workdir: directory,
        }),
      );
      const capture = vi.fn(() =>
        Promise.resolve({
          checkpointId: "checkpoint_1",
          createdAt: 2,
          fileCount: 0,
          patchId: "patch_1",
          postTreeRef: "b".repeat(40),
        }),
      );
      const snapshotService = {
        capture,
        track,
      } as unknown as SnapshotService;
      const failingHook: HookExecutor = {
        execute: vi.fn(() => Promise.reject(new Error("ordinary hook failed"))),
      };

      const client = createPersistentUiBackendClient({
        dbPath: join(directory, "agent.db"),
        enableSnapshots: true,
        hookExecutor: failingHook,
        llmClient: createFakeLLMClient([
          { textDelta: "Snapshot enabled", finishReason: "stop" },
        ]),
        snapshotService,
        workdir: directory,
      });

      await client.submitPromptAndWait("Run with snapshot");

      expect(track).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

it("refreshes a seeded SQLite view only after actual orphan repair and leaves retained work unsent", async () => {
  const directory = await tempDir("ohbaby-entry-repair-");
  let client: PersistentUiBackendClient | undefined;
  try {
    const workdir = join(directory, "workspace");
    const llm = createFakeLLMClient([
      { textDelta: "seed", finishReason: "stop" },
    ]);
    const execute = vi.spyOn(llm.provider, "streamResponse");
    client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      workdir,
      llmClient: llm,
    });
    await client.submitPromptAndWait("seed");
    const sessionId = (await client.getSnapshot()).activeSessionId;
    if (!sessionId) throw new Error("Missing session");
    await client.initializeSession(sessionId);
    if (!client.getSessionView || !client.getSessionControl)
      throw new Error("Missing recovery API");
    const before = await client.getSessionView({ sessionId });
    const executions = execute.mock.calls.length;
    const ledger = createDatabaseRunLedger({
      ownerId: "dead",
      ownerPid: 2147483647,
    });
    await ledger.createPending({
      runId: "late-orphan",
      sessionId,
      triggerSource: "user",
    });
    await ledger.markRunning("late-orphan");
    await createDatabaseMessageStore().insertMessage({
      id: "orphan-answer",
      agent: "default",
      role: "assistant",
      sessionId,
      runId: "late-orphan",
      time: { created: Date.now() },
    });
    const { DatabasePromptSubmissionStore } =
      await import("../runtime/prompt-scheduler/database-store.js");
    const prompts = new DatabasePromptSubmissionStore({
      ownerId: "dead",
      ownerPid: 2147483647,
    });
    await prompts.accept({
      promptId: "late-queued",
      clientRequestId: "late-queued",
      scopeKey: workdir,
      sessionId,
      text: "do not auto-send",
      userMessageId: "late-user",
      maxQueuedPrompts: 100,
    });
    await client.initializeSession(sessionId);
    const repaired = await client.getSessionView({ sessionId });
    expect(repaired.version.viewGeneration).not.toBe(
      before.version.viewGeneration,
    );
    expect(repaired.runs.find((run) => run.id === "late-orphan")).toMatchObject(
      { status: { kind: "error" }, outcome: "interrupted" },
    );
    expect(
      repaired.prompts.find((prompt) => prompt.promptId === "late-queued")
        ?.status,
    ).toBe("retained");
    expect(repaired.executionRecovery).toEqual({ status: "ready" });
    expect((await client.getSessionControl({ sessionId })).runId).toBeNull();
    await client.initializeSession(sessionId);
    expect((await client.getSessionView({ sessionId })).version).toEqual(
      repaired.version,
    );
    expect(execute.mock.calls.length).toBe(executions);
  } finally {
    await client?.dispose();
    closeDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

it.each(["compact", "prompt"] as const)(
  "rejects cross-workspace %s admission when persistent backends share a database",
  async (operation) => {
    const directory = await tempDir("ohbaby-manual-owner-scope-");
    const clients: PersistentUiBackendClient[] = [];
    try {
      const dbPath = join(directory, "agent.db");
      const projectA = join(directory, "project-a");
      const projectB = join(directory, "project-b");
      await mkdir(projectA, { recursive: true });
      await mkdir(projectB, { recursive: true });
      const owner = createPersistentUiBackendClient({
        dbPath,
        workdir: projectA,
        llmClient: createFakeLLMClient([
          { textDelta: "Owner response", finishReason: "stop" },
        ]),
      });
      const other = createPersistentUiBackendClient({
        dbPath,
        workdir: projectB,
        llmClient: createFakeLLMClient([
          { textDelta: "Other response", finishReason: "stop" },
        ]),
      });
      clients.push(owner, other);
      await owner.submitPromptAndWait("Owned by workspace A");
      const sessionId = (await owner.getSnapshot()).activeSessionId;
      if (!sessionId) throw new Error("Expected owner session");
      if (!owner.getSessionView)
        throw new Error("Expected session view support");
      const before = (await owner.getSessionView({ sessionId })).session
        .messages;
      const action =
        operation === "compact"
          ? other.compactSession({ sessionId })
          : other.submitPromptAccepted("Must not enter another workspace", {
              sessionId,
            });
      await expect(action).rejects.toThrow(/another workspace/);
      expect(
        (await owner.getSessionView({ sessionId })).session.messages,
      ).toEqual(before);
      await expect(owner.compactSession({ sessionId })).resolves.toMatchObject({
        sessionId,
      });
      await expect(
        other.submitPromptAndWait("Work in B"),
      ).resolves.toMatchObject({ prompt: { status: "succeeded" } });
    } finally {
      await Promise.all(clients.map((client) => client.dispose()));
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  },
);

it("S4-10 isolates failed recovery from healthy sessions and readable history until explicit retry", async () => {
  const directory = await tempDir("ohbaby-steer-startup-recovery-");
  const release = createDeferred<undefined>();
  const started = createDeferred<undefined>();
  let client: PersistentUiBackendClient | undefined;
  try {
    const workdir = join(directory, "workspace");
    const dbPath = join(directory, "agent.db");
    client = createPersistentUiBackendClient({
      dbPath,
      workdir,
      llmClient: createFakeLLMClient([
        { textDelta: "seed", finishReason: "stop" },
      ]),
    });
    const first = await client.submitPromptAccepted("seed recovery session");
    await client.waitForPrompt(first.promptId);
    const other = await client.createSession();
    await client.submitPromptAndWait("healthy session", {
      sessionId: other.id,
    });
    await client.dispose();
    client = undefined;
    const ledger = createDatabaseRunLedger({
      ownerId: "old-owner",
      ownerPid: 2147483647,
    });
    await ledger.createPending({
      runId: "stale-steer-run",
      sessionId: first.sessionId,
      triggerSource: "user",
    });
    await ledger.markRunning("stale-steer-run");
    const { DatabasePromptSubmissionStore } =
      await import("../runtime/prompt-scheduler/database-store.js");
    const { DatabaseCurrentRunInputStore } =
      await import("../runtime/prompt-scheduler/current-run-inputs.js");
    const prompts = new DatabasePromptSubmissionStore({
      ownerId: "old-owner",
      ownerPid: 2147483647,
    });
    await prompts.accept({
      promptId: "stale-steer-prompt",
      userMessageId: "stale-steer-message",
      clientRequestId: "stale-accept",
      sessionId: first.sessionId,
      scopeKey: workdir,
      text: "recover my original guidance",
      maxQueuedPrompts: 100,
    });
    const inputs = new DatabaseCurrentRunInputStore();
    await inputs.steerQueued({
      promptId: "stale-steer-prompt",
      expectedRunId: "stale-steer-run",
      clientRequestId: "stale-steer",
      sessionId: first.sessionId,
      scopeKey: workdir,
    });
    getDatabase()
      .prepare(
        "UPDATE run_ledger SET owner_id=NULL, owner_pid=NULL WHERE run_id='stale-steer-run'",
      )
      .run();
    client = createPersistentUiBackendClient({
      dbPath,
      workdir,
      resumeSessionId: other.id,
      llmClient: createConcurrentBlockingLLMClient({
        onStarted: () => {
          started.resolve(undefined);
        },
        release: release.promise,
      }),
    });
    if (!client.getSessionView || !client.getSessionHistory)
      throw new Error("Session recovery API unavailable");
    const snapshot = await client.getSnapshot();
    expect(
      snapshot.sessions.find((session) => session.id === first.sessionId)
        ?.unconsumedSteers,
    ).toBeUndefined();
    await client.initializeSession(other.id);
    expect(
      (await client.getSessionView({ sessionId: other.id })).session
        .unconsumedSteers,
    ).toEqual([]);
    await expect(client.initializeSession(first.sessionId)).rejects.toThrow(
      /unknown owner/i,
    );
    const blocked = await client.getSessionView({ sessionId: first.sessionId });
    expect(blocked.session.unconsumedSteers).toBeUndefined();
    expect(blocked.executionRecovery?.status).toBe("blocked");
    expect(blocked.executionRecovery).toHaveProperty(
      "message",
      expect.stringMatching(/unknown owner/i),
    );
    expect(JSON.stringify(blocked.session.messages)).toContain(
      "seed recovery session",
    );
    expect(
      JSON.stringify(
        (await client.getSessionHistory({ sessionId: first.sessionId }))
          .messages,
      ),
    ).toContain("seed recovery session");
    const healthy = await client.submitPromptAccepted("still healthy", {
      sessionId: other.id,
    });
    await started.promise;
    const queued = await client.submitPromptAccepted("cancel healthy queue", {
      sessionId: other.id,
    });
    expect(queued.status).toBe("queued");
    expect(
      (await client.cancelQueuedPrompt({ promptId: queued.promptId })).status,
    ).toBe("cancelled");
    release.resolve(undefined);
    expect((await client.waitForPrompt(healthy.promptId)).prompt.status).toBe(
      "succeeded",
    );
    // Reading again must retain unknown recovery, without retrying execution repair.
    expect(
      (await client.getSnapshot()).sessions.find(
        (session) => session.id === first.sessionId,
      )?.unconsumedSteers,
    ).toBeUndefined();
    getDatabase()
      .prepare(
        "UPDATE run_ledger SET owner_id='old-owner', owner_pid=2147483647 WHERE run_id='stale-steer-run'",
      )
      .run();
    await client.initializeSession(first.sessionId);
    const view = await client.getSessionView({ sessionId: first.sessionId });
    expect(view.executionRecovery).toEqual({ status: "ready" });
    expect(view.session.unconsumedSteers).toMatchObject([
      {
        promptId: "stale-steer-prompt",
        text: "recover my original guidance",
        state: "unconsumed",
      },
    ]);
    expect(
      (await client.getSnapshot()).sessions.find(
        (session) => session.id === first.sessionId,
      )?.unconsumedSteers,
    ).toEqual(view.session.unconsumedSteers);
  } finally {
    release.resolve(undefined);
    await client?.dispose();
    closeDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

describe("persistent conversation rewind", () => {
  let directory: string;
  let client: PersistentUiBackendClient;
  const requests: InterfaceProviderRequest[] = [];
  let model: LLMClientInstance<FakeSdkClient>;
  function open(hookExecutor?: HookExecutor): PersistentUiBackendClient {
    return createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      workdir: join(directory, "workspace"),
      llmClient: model,
      enableSnapshots: false,
      hookExecutor,
    });
  }
  beforeEach(async () => {
    directory = await tempDir("ohbaby-rewind-");
    vi.stubEnv("OHBABY_HOME", join(directory, "home"));
    requests.length = 0;
    model = createSequentialFakeLLMClient(
      Array.from({ length: 8 }, () => [
        { textDelta: "Reply", finishReason: "stop" },
      ]),
      requests,
    );
  });
  afterEach(async () => {
    await client.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { force: true, recursive: true });
  });

  it("rewinds a suffix across saved history, open views, exports, model input and restart", async () => {
    client = open();
    if (!client.getSessionView || !client.getSessionHistory)
      throw new Error("Expected persistent session recovery support");
    const first = (await client.submitPromptAndWait("keep the first turn"))
      .prompt;
    const sessionId = first.sessionId;
    const input = { sessionId };
    const second = (
      await client.submitPromptAndWait("second-rewind-needle", input)
    ).prompt;
    const third = (
      await client.submitPromptAndWait(
        "third-rewind-needle " + "discard ".repeat(600),
        input,
      )
    ).prompt;
    const before = await client.getSessionView(input);
    const cutoff = before.session.messages.findIndex(
      (message) => message.id === second.userMessageId,
    );
    expect(cutoff).toBeGreaterThan(0);
    const removed = before.session.messages
      .slice(cutoff)
      .map((message) => message.id);
    const previousUsage = await client.getContextWindowUsage(input);
    expect(
      searchGlobalSessions({ query: "second-rewind-needle" }).hits.some(
        (hit) => hit.session.id === sessionId,
      ),
    ).toBe(true);
    const db = getDatabase();
    const messageRows = db.prepare<{ id: string; rewound_at: string | null }>(
      "SELECT id,rewound_at FROM message WHERE session_id=? ORDER BY created_at,rowid",
    );
    const originalRows = messageRows.all(sessionId);
    const firstRemoved = originalRows.findIndex(
      (row) => row.id === second.userMessageId,
    );
    expect(firstRemoved).toBeGreaterThan(0);
    const changes: UiEvent[] = [];
    client.subscribeEvents((event) => changes.push(event));
    const result = await client.rewindSession({
      sessionId,
      promptId: second.promptId,
    });
    expect(result).toEqual({ sessionId, restoredText: second.text });

    const snapshot = await client.getSnapshot();
    expect(
      snapshot.runs.some(
        (run) => run.id === second.runId || run.id === third.runId,
      ),
    ).toBe(false);
    const warm = await client.getSessionView(input);
    expect(warm.prompts.map((p) => p.promptId)).toEqual([first.promptId]);
    expect(warm.runs.map((r) => r.id)).toEqual([first.runId]);
    const retained = warm.session.messages.map((m) => m.id);
    expect(retained).toContain(first.userMessageId);
    expect(removed).toContain(second.userMessageId);
    expect(removed).toContain(third.userMessageId);
    const deltas = changes.filter((e) => e.type === "session.changed");
    const removedIds = deltas.flatMap((e) => e.removedMessageIds ?? []);
    for (const id of removed) expect(removedIds).toContain(id);
    const stamps = deltas
      .flatMap((e) => e.prompts ?? [])
      .filter((p) => p.rewoundAt);
    for (const target of [second, third]) {
      expect(
        stamps.some(
          (p) => p.promptId === target.promptId && p.updatedAt === p.rewoundAt,
        ),
      ).toBe(true);
    }
    const marks = getDatabase()
      .prepare<{
        rewound_at: string;
      }>(
        "SELECT DISTINCT rewound_at FROM message WHERE session_id=? AND rewound_at IS NOT NULL UNION SELECT DISTINCT rewound_at FROM prompt_submission WHERE session_id=? AND rewound_at IS NOT NULL",
      )
      .all(sessionId, sessionId);
    expect(marks).toEqual([{ rewound_at: stamps[0].rewoundAt }]);
    expect(messageRows.all(sessionId)).toEqual(
      originalRows.map((row, index) => ({
        id: row.id,
        rewound_at: index < firstRemoved ? null : stamps[0].rewoundAt,
      })),
    );
    const lastPage = await client.getSessionHistory({ sessionId, limit: 1 });
    expect(lastPage.hasMore).toBe(true);
    const earlier = await client.getSessionHistory({
      sessionId,
      before: lastPage.before,
    });
    expect(
      [...earlier.messages, ...lastPage.messages].map((m) => m.id),
    ).toEqual(retained);
    for (const format of ["html", "jsonl"] as const) {
      const exported = await client.exportSession({ sessionId, format });
      const contents =
        format === "html"
          ? Buffer.from(
              /<script[^>]*id="session-data"[^>]*>([^<]*)<\/script>/.exec(
                exported.content,
              )?.[1] ?? "",
              "base64",
            ).toString("utf8")
          : exported.content;
      expect(contents).toContain(first.text);
      expect(contents).not.toContain("rewind-needle");
    }
    expect(
      searchGlobalSessions({ query: "second-rewind-needle" }).hits,
    ).toEqual([]);
    const usage = await client.getContextWindowUsage(input);
    if (!usage || !previousUsage)
      throw new Error("Expected context usage on both sides of rewind");
    expect(usage.currentTokens).toBeLessThan(previousUsage.currentTokens);
    await client.dispose();
    client = open();
    if (!client.getSessionView || !client.getSessionHistory)
      throw new Error("Expected persistent session recovery support");
    await client.initializeSession(sessionId);
    const cold = await client.getSessionView(input);
    expect(cold.session.messages.map((m) => m.id)).toEqual(retained);
    expect(cold.runs.map((r) => r.id)).toEqual([first.runId]);
    const follow = (
      await client.submitPromptAndWait("next visible turn", input)
    ).prompt;
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain(first.text);
    expect(sent).toContain(follow.text);
    expect(sent).not.toContain("rewind-needle");
    await client.rewindSession({ sessionId, promptId: follow.promptId });
    expect(
      (await client.getSessionView(input)).session.messages.map((m) => m.id),
    ).toEqual(retained);
    const stats = db.prepare("SELECT message_count FROM session WHERE id=?");
    expect(stats.get(sessionId)).toEqual({ message_count: firstRemoved });
    await client.rewindSession({ sessionId, promptId: first.promptId });
    expect(stats.get(sessionId)).toEqual({ message_count: 0 });
    const empty = (await client.getSessionView(input)).session;
    expect(empty.messages).toEqual([]);
    expect(empty.title).toBe(before.session.title);
    const neverReuse = await client.createSession({
      reuseSessionId: sessionId,
    });
    expect(neverReuse.id).not.toBe(sessionId);
    await client.submitPromptAndWait("a different title would be wrong", input);
    expect((await client.getSessionView(input)).session.title).toBe(
      before.session.title,
    );
  });

  it.each(["resubmitted", "earlier"] as const)(
    "rewinds the %s turn by message order after a retained retry and a queued steer",
    async (cut) => {
      const release = createDeferred<undefined>();
      const started = createDeferred<undefined>();
      model = createBlockingLLMClient({
        started,
        release: release.promise,
        text: "reply",
      });
      client = open();
      const { id: sessionId } = await client.createSession();
      const scope = join(directory, "workspace");
      const fixedTime = Date.now() + 60000;
      const store = new DatabasePromptSubmissionStore({
        now: (): number => fixedTime,
      });
      const admit = (
        id: string,
        scopeKey = scope,
      ): ReturnType<typeof store.accept> =>
        store.accept({
          sessionId,
          scopeKey,
          promptId: id,
          userMessageId: id + "-message",
          clientRequestId: id,
          text: id,
          maxQueuedPrompts: 20,
        });
      await admit("A");
      await store.retainOwnedQueued(scope);
      // A and the future steer exist before B, but they materialize on opposite sides of the cut.
      await admit("steer");
      const b = await client.submitPromptAccepted("B", { sessionId });
      try {
        await started.promise;
        const runId = (await store.get(b.promptId))?.runId;
        if (!runId) throw new Error("Expected B to be running");
        expect(
          await client.steerQueuedPrompt({
            promptId: "steer",
            expectedRunId: runId,
            clientRequestId: "steer-into-B",
          }),
        ).toMatchObject({ status: "steered" });
      } finally {
        release.resolve(undefined);
      }
      await client.waitForPrompt(b.promptId);
      await admit("between", "/old-workspace");
      await store.cancelQueued("between");
      const lease = await client.acquirePromptEditLease({ promptId: "A" });
      await client.resubmitRetainedPrompt({
        promptId: "A",
        operationId: "retry-A",
        editLeaseId: lease.editLeaseId,
        text: "A again",
      });
      const { prompt: a } = await client.waitForPrompt("A");
      await admit("after", "/other-workspace");
      await store.cancelQueued("after");
      // Already cancelled prompts have no message. All three admissions tie on time, across scopes.
      expect((await store.get("between"))?.acceptedAt).toBe(
        (await store.get("A"))?.acceptedAt,
      );
      expect((await store.get("after"))?.acceptedAt).toBe(
        (await store.get("A"))?.acceptedAt,
      );
      const stop = vi.spyOn(SessionSubagentHost.prototype, "stopRewoundRoot");
      try {
        await client.rewindSession({
          sessionId,
          promptId: cut === "resubmitted" ? a.promptId : b.promptId,
        });
        const retained = cut === "resubmitted";
        for (const id of [b.promptId, "steer", "between"])
          expect(Boolean((await store.get(id))?.rewoundAt)).toBe(!retained);
        for (const id of ["A", "after"])
          expect((await store.get(id))?.rewoundAt).toBeTruthy();
        const messages = (
          await client.getSessionView?.({ sessionId })
        )?.session.messages.map((m) => m.id);
        expect(messages?.includes(b.userMessageId)).toBe(retained);
        expect(messages?.includes("steer-message")).toBe(retained);
        expect(messages).not.toContain(a.userMessageId);
        const bRun = (await store.get(b.promptId))?.runId;
        expect(stop.mock.calls.map(([runId]) => runId)).toEqual(
          expect.arrayContaining([a.runId]),
        );
        expect(stop.mock.calls.some(([runId]) => runId === bRun)).toBe(
          !retained,
        );
      } finally {
        stop.mockRestore();
      }
    },
  );

  it("checks a running target before stopping and cancels its owner's queued drafts before admitting a replacement", async () => {
    const release = createDeferred<undefined>();
    const startedTexts: string[] = [];
    model = createAbortableBlockingLLMClient({
      release: release.promise,
      startedTexts,
      partialText: "streaming",
    });
    client = open();
    if (!client.getSessionView || !client.getSessionHistory)
      throw new Error("Expected persistent session recovery support");
    try {
      const running = await client.submitPromptAccepted("running question", {
        modelEntryId: "injected",
        reasoning: { enabled: false },
      });
      const { sessionId, promptId } = running;
      await vi.waitFor(() => {
        expect(startedTexts).toContain("running question");
      });
      const db = getDatabase();
      const run = db
        .prepare<{
          run_id: string;
        }>("SELECT run_id FROM run_ledger WHERE session_id=?")
        .get(sessionId);
      if (!run) throw new Error("Expected a running turn");
      const steer = await client.submitPromptAccepted("inline steer", {
        sessionId,
      });
      const steered = await client.steerQueuedPrompt({
        promptId: steer.promptId,
        expectedRunId: run.run_id,
        clientRequestId: "apply-steer",
      });
      expect(steered.status).toBe("steered");
      await expect(
        client.rewindSession({ sessionId, promptId: steer.promptId }),
      ).rejects.toMatchObject({ code: "REWIND_TARGET_INVALID" });
      const draft = await client.submitPromptAccepted("first queued", {
        sessionId,
      });
      const other = await client.submitPromptAccepted("second queued", {
        sessionId,
      });
      await expect(
        client.rewindSession({ sessionId, promptId: draft.promptId }),
      ).rejects.toMatchObject({ code: "REWIND_TARGET_INVALID" });
      const setModel = db.prepare(
        "UPDATE prompt_submission SET model_entry_id=? WHERE prompt_id=?",
      );
      setModel.run("deleted-model", promptId);
      await expect(
        client.rewindSession({ sessionId, promptId, text: "wrong model" }),
      ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
      setModel.run("injected", promptId);
      const setStatus = db.prepare(
        "UPDATE prompt_submission SET status=? WHERE prompt_id=?",
      );
      setStatus.run("retained", other.promptId);
      await expect(
        client.rewindSession({ sessionId, promptId }),
      ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
      setStatus.run("queued", other.promptId);
      await client.acquirePromptEditLeaseForOwner(
        { promptId: draft.promptId },
        "editor",
      );
      await expect(
        client.rewindSessionForOwner({ sessionId, promptId }, "other"),
      ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
      const stillRunning = await client.getSessionView({ sessionId });
      expect(
        stillRunning.prompts.find((p) => p.promptId === promptId)?.status,
      ).toBe("running");
      const response = await client.rewindSessionForOwner(
        { sessionId, promptId, text: "replacement" },
        "editor",
      );
      expect(response.restoredText).toBe("running question");
      if (!response.prompt) throw new Error("Expected replacement receipt");
      release.resolve(undefined);
      expect(
        (await client.waitForPrompt(response.prompt.promptId)).prompt.status,
      ).toBe("succeeded");
      expect(startedTexts).toEqual(["running question", "replacement"]);
      const states = getDatabase()
        .prepare<{
          prompt_id: string;
          status: string;
          rewound_at: string | null;
        }>(
          "SELECT prompt_id,status,rewound_at FROM prompt_submission WHERE session_id=? ORDER BY admission_order",
        )
        .all(sessionId);
      expect(
        states.map((p) => [p.prompt_id, p.status, Boolean(p.rewound_at)]),
      ).toEqual([
        [promptId, "interrupted", true],
        [steer.promptId, "steered", true],
        [draft.promptId, "cancelled", true],
        [other.promptId, "cancelled", true],
        [response.prompt.promptId, "succeeded", false],
      ]);
      const settings = db.prepare(
        "SELECT model_entry_id,reasoning_data FROM prompt_submission WHERE prompt_id=?",
      );
      expect(settings.get(response.prompt.promptId)).toEqual({
        model_entry_id: "injected",
        reasoning_data: JSON.stringify({ enabled: false }),
      });
    } finally {
      release.resolve(undefined);
    }
  });

  it.each([
    { mode: "explicit with replacement", replacement: "edited" },
    { mode: "implicit without replacement", replacement: undefined },
  ])(
    "preserves a new window's question behind a rewind ($mode)",
    async ({ replacement }) => {
      const finalizing = createDeferred<undefined>();
      const releaseModel = createDeferred<undefined>();
      const settle = createDeferred<undefined>();
      const startedTexts: string[] = [];
      model = createAbortableBlockingLLMClient({
        release: releaseModel.promise,
        startedTexts,
      });
      client = open({
        async execute(point, { status }) {
          if (point === "post-run" && status === "cancelled") {
            releaseModel.resolve(undefined);
            finalizing.resolve(undefined);
            await settle.promise;
          }
        },
      });
      const independent = open();
      try {
        const target = await client.submitPromptAccepted("original");
        const { sessionId } = target;
        await vi.waitFor(() => {
          expect(startedTexts).toEqual(["original"]);
        });
        const old = await client.submitPromptAccepted("queued before rewind", {
          sessionId,
        });
        const input = {
          sessionId,
          promptId: target.promptId,
          text: replacement,
        };
        await expect(independent.rewindSession(input)).rejects.toMatchObject({
          code: "SESSION_RUNNING",
        });

        const rewind = client.rewindSessionForOwner(input, "window-a");
        // Same-tick explicit requests must observe invocation order, even before preflight finishes.
        const immediate = replacement
          ? client.submitPromptAccepted("sent during rewind", { sessionId })
          : undefined;
        await finalizing.promise;
        await expect(
          independent.compactSession({ sessionId, force: true }),
        ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
        const incoming =
          immediate ?? client.submitPromptAccepted("sent during rewind");
        const followUp = client.submitPromptAccepted("second late question", {
          sessionId,
        });
        // Waiting on this rewind must also leave workspace-wide session creation available.
        const otherSession = await withTimeout(
          client.createSession(),
          3_000,
          "waiting on rewind blocked the creation of an unrelated session",
        );
        await client.submitPromptAndWait("unrelated", {
          sessionId: otherSession.id,
        });
        expect(startedTexts).toEqual(["original", "unrelated"]);
        settle.resolve(undefined);
        const [result, late, last] = await Promise.all([
          rewind,
          incoming,
          followUp,
        ]);
        expect(result.restoredText).toBe("original");
        expect(late.sessionId).toBe(sessionId);
        expect((await client.waitForPrompt(last.promptId)).prompt.status).toBe(
          "succeeded",
        );
        expect(startedTexts).toEqual([
          "original",
          "unrelated",
          ...(replacement ? [replacement] : []),
          "sent during rewind",
          "second late question",
        ]);
        const rows = getDatabase()
          .prepare(
            "SELECT prompt_id,status,rewound_at IS NOT NULL AS hidden FROM prompt_submission WHERE session_id=? ORDER BY admission_order",
          )
          .all(sessionId);
        expect(rows).toEqual([
          { prompt_id: target.promptId, status: "interrupted", hidden: 1 },
          { prompt_id: old.promptId, status: "cancelled", hidden: 1 },
          ...(replacement
            ? [
                {
                  prompt_id: result.prompt?.promptId,
                  status: "succeeded",
                  hidden: 0,
                },
              ]
            : []),
          { prompt_id: late.promptId, status: "succeeded", hidden: 0 },
          { prompt_id: last.promptId, status: "succeeded", hidden: 0 },
        ]);
      } finally {
        releaseModel.resolve(undefined);
        settle.resolve(undefined);
        await independent.dispose();
      }
    },
  );

  it("keeps history visible while another backend is summarizing it", async () => {
    const entered = createDeferred<undefined>();
    const finish = createDeferred<undefined>();
    const fallback = model.provider.streamResponse.bind(model.provider);
    vi.spyOn(model.provider, "streamResponse").mockImplementation(
      async (request) => {
        if (request.purpose !== "context-summary") return fallback(request);
        entered.resolve(undefined);
        await finish.promise;
        return createProviderStream([
          { textDelta: "The lantern is blue.", finishReason: "stop" },
        ]);
      },
    );
    client = open();
    const peer = open();
    try {
      const { prompt } = await client.submitPromptAndWait(
        "Keep the blue lantern. ".repeat(6000),
      );
      const { sessionId, promptId } = prompt;
      await client.submitPromptAndWait("Continue with the lantern.", {
        sessionId,
      });
      const db = getDatabase();
      // A stale marker left by a previous process with this PID may be reclaimed.
      db.prepare(
        "INSERT INTO app_state(scope,key,value,updated_at) VALUES('session-history-operation',?,?,0)",
      ).run(
        sessionId,
        JSON.stringify({ pid: process.pid, processId: "previous-process" }),
      );
      const compact = peer.compactSession({ sessionId, force: true });
      try {
        await withTimeout(
          entered.promise,
          3000,
          "summary request did not enter",
        );
        await expect(
          client.rewindSession({ sessionId, promptId }),
        ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
        expect(
          db
            .prepare(
              "SELECT id FROM message WHERE session_id=? AND rewound_at IS NOT NULL",
            )
            .all(sessionId),
        ).toEqual([]);
      } finally {
        finish.resolve(undefined);
        expect((await compact).status).toBe("compacted");
      }
      db.exec(`CREATE TEMP TRIGGER fail_history_release BEFORE DELETE ON app_state
        WHEN OLD.scope='session-history-operation' BEGIN SELECT RAISE(ABORT, 'history release failed'); END`);
      try {
        await expect(
          client.rewindSession({ sessionId, promptId }),
        ).rejects.toThrow("history release failed");
      } finally {
        db.exec("DROP TRIGGER fail_history_release");
      }
      await expect(
        client.rewindSession({ sessionId, promptId }),
      ).rejects.toMatchObject({ code: "REWIND_BEFORE_COMPACTION" });
    } finally {
      finish.resolve(undefined);
      await peer.dispose();
    }
  });

  it("rejects inaccessible sessions, foreign prompts and cuts before compaction without marking any history", async () => {
    client = open();
    const { prompt } = await client.submitPromptAndWait("an old user question");
    const { sessionId, promptId } = prompt;
    const other = await client.createSession();
    const archived = await client.createSession();
    await client.archiveSession({ sessionId: archived.id });
    const side = await client.openSideChat({ mainSessionId: sessionId });
    const child = await client.createSession();
    const db = getDatabase();
    db.prepare("UPDATE session SET parent_id=? WHERE id=?").run(
      sessionId,
      child.id,
    );
    for (const [id, code] of [
      ["missing", "SESSION_NOT_FOUND"],
      [child.id, "SESSION_NOT_ROOT"],
      [archived.id, "SESSION_ARCHIVED"],
      [side.sideChatId, "SIDE_CHAT_UNSUPPORTED"],
      [other.id, "REWIND_TARGET_INVALID"],
    ]) {
      await expect(
        client.rewindSession({ sessionId: id, promptId }),
      ).rejects.toMatchObject({ code });
    }
    db.prepare("UPDATE session SET status='archived' WHERE id=?").run(
      side.sideChatId,
    );
    await expect(
      client.rewindSession({ sessionId: side.sideChatId, promptId }),
    ).rejects.toMatchObject({ code: "SESSION_ARCHIVED" });
    const at = Date.now() + 1;
    insertMessageRow(db, {
      id: "rewind-summary",
      sessionId,
      role: "assistant",
      agent: "context",
      time: { created: at },
    });
    insertPartRow(
      db,
      {
        id: "rewind-summary-part",
        messageId: "rewind-summary",
        sessionId,
        type: "text",
        text: "compacted history",
        orderIndex: 0,
        metadata: { kind: "context-summary" },
      },
      at,
    );
    await expect(
      client.rewindSession({ sessionId, promptId }),
    ).rejects.toMatchObject({ code: "REWIND_BEFORE_COMPACTION" });
    expect(
      db.prepare("SELECT 1 FROM message WHERE rewound_at IS NOT NULL").all(),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT 1 FROM prompt_submission WHERE rewound_at IS NOT NULL")
        .all(),
    ).toEqual([]);
  });

  function startRewindTestGoal(
    sessionId: string,
  ): ReturnType<PersistentUiBackendClient["executeCommand"]> {
    return client.executeCommand({
      sessionId,
      commandId: "goal",
      path: ["goal"],
      argv: ["inspect files"],
      raw: "/goal inspect files",
      rawArgs: "inspect files",
      surface: "tui",
      clientInvocationId: "goal",
    });
  }

  function backgroundChildCall(): InterfaceProviderStreamEvent {
    return createProviderSubagentControlEvent({
      callId: "spawn",
      action: "spawn",
      arguments: { prompt: "inspect files", role: "explore" },
    });
  }

  it("pauses an idle goal and defers its retained child's wake until rewind releases the gate", async () => {
    const releaseChild = createDeferred<undefined>();
    const inCleanup = createDeferred<undefined>();
    const releaseCleanup = createDeferred<undefined>();
    const fallback = model.provider.streamResponse.bind(model.provider);
    let spawn = true;
    vi.spyOn(model.provider, "streamResponse").mockImplementation(
      async (request) => {
        if (isSessionTitleGenerationRequest(request)) return fallback(request);
        if (isPersistentExploreSubagentRequest(request)) {
          await releaseChild.promise;
          return createProviderStream([
            { textDelta: "child result", finishReason: "stop" },
          ]);
        }
        if (spawn) {
          spawn = false;
          return createProviderStream([backgroundChildCall()]);
        }
        return fallback(request);
      },
    );
    client = open();
    const { id: sessionId } = await client.createSession();
    const ledger = createDatabaseRunLedger();
    const mainRuns = (): ReturnType<typeof ledger.listBySession> =>
      ledger.listBySession(sessionId, { mainOnly: true });
    const child = (): Record<string, unknown> | undefined =>
      getDatabase()
        .prepare(
          "SELECT status,rewound_at FROM subagent_execution WHERE root_session_id=?",
        )
        .get(sessionId);
    let observer: PersistentUiBackendClient | undefined;
    try {
      await startRewindTestGoal(sessionId);
      await vi.waitFor(async () => {
        expect(await mainRuns()).toMatchObject([
          { triggerSource: "goal", status: "succeeded" },
        ]);
      });
      const { prompt } = await client.submitPromptAndWait("later user turn", {
        sessionId,
      });
      expect(
        (await client.getSessionView?.({ sessionId }))?.goal,
      ).toMatchObject({ status: "ready", value: { status: "active" } });
      observer = open();
      await observer.initializeSession(sessionId);
      expect(
        (await observer.getSessionView?.({ sessionId }))?.goal,
      ).toMatchObject({
        value: { status: "active" },
      });
      await expect(
        observer.rewindSession({ sessionId, promptId: prompt.promptId }),
      ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
      const barrier = vi.spyOn(
        SessionSubagentHost.prototype,
        "stopRewoundRoot",
      );
      barrier.mockImplementationOnce(async function (
        this: SessionSubagentHost,
        runId,
      ) {
        inCleanup.resolve(undefined);
        await releaseCleanup.promise;
        barrier.mockRestore();
        return this.stopRewoundRoot(runId);
      });
      try {
        const rewind = client.rewindSession({
          sessionId,
          promptId: prompt.promptId,
        });
        await inCleanup.promise;
        expect(child()).toMatchObject({ status: "running", rewound_at: null });
        releaseChild.resolve(undefined);
        await vi.waitFor(() => {
          expect(child()).toMatchObject({
            status: "completed",
            rewound_at: null,
          });
        });
        expect((await mainRuns()).map((run) => run.triggerSource)).toEqual([
          "user",
          "goal",
        ]);
        releaseCleanup.resolve(undefined);
        await rewind;
        expect(
          (await observer.getSessionView?.({ sessionId }))?.goal,
        ).toMatchObject({ value: { status: "paused" } });
      } finally {
        releaseCleanup.resolve(undefined);
        barrier.mockRestore();
      }
      await vi.waitFor(async () => {
        expect(await mainRuns()).toMatchObject([
          { triggerSource: "subagent", status: "succeeded" },
          { triggerSource: "user" },
          { triggerSource: "goal" },
        ]);
      });
      expect(
        (await client.getSessionView?.({ sessionId }))?.goal,
      ).toMatchObject({
        status: "ready",
        value: { status: "paused", turnsUsed: 1 },
      });
    } finally {
      releaseCleanup.resolve(undefined);
      releaseChild.resolve(undefined);
      await observer?.dispose();
    }
  });

  it.each(["goal", "subagent"] as const)(
    "interrupts a running %s turn when rewinding an earlier user prompt",
    async (driver) => {
      client = open();
      const { prompt: target } =
        await client.submitPromptAndWait("old question");
      const { sessionId, promptId } = target;
      const releaseChild = createDeferred<undefined>();
      const release = createDeferred<undefined>();
      const startedTexts: string[] = [];
      const blocking = createAbortableBlockingLLMClient({
        release: release.promise,
        startedTexts,
      });
      const fallback = model.provider.streamResponse.bind(model.provider);
      let spawn = driver === "subagent";
      let block = driver === "goal";
      vi.spyOn(model.provider, "streamResponse").mockImplementation(
        async (request) => {
          if (isSessionTitleGenerationRequest(request))
            return fallback(request);
          if (isPersistentExploreSubagentRequest(request)) {
            await releaseChild.promise;
            return createProviderStream([
              { textDelta: "child result", finishReason: "stop" },
            ]);
          }
          if (spawn) {
            spawn = false;
            return createProviderStream([backgroundChildCall()]);
          }
          if (block) return blocking.provider.streamResponse(request);
          return fallback(request);
        },
      );
      try {
        if (driver === "goal") {
          await startRewindTestGoal(sessionId);
        } else {
          await client.submitPromptAndWait("spawn child", { sessionId });
          block = true;
          releaseChild.resolve(undefined);
        }
        await vi.waitFor(() => {
          expect(startedTexts).toHaveLength(1);
        });
        block = false;
        const ledger = createDatabaseRunLedger();
        const [active] = await ledger.listBySession(sessionId, {
          mainOnly: true,
        });
        expect(active).toMatchObject({
          triggerSource: driver,
          status: "running",
        });
        // At a goal run's steering cutoff, new prompts queue for the next turn.
        if (driver === "goal")
          await new DatabaseCurrentRunInputStore().sealSteer(active.runId);
        const drafts = await Promise.all(
          ["draft one", "draft two"].map((text) =>
            client.submitPromptAccepted(text, { sessionId }),
          ),
        );
        expect(drafts.map((p) => p.status)).toEqual(["queued", "queued"]);
        const result = await client.rewindSession({
          sessionId,
          promptId,
          text: "updated",
        });
        if (!result.prompt) throw new Error("Expected replacement prompt");
        expect(
          (await client.waitForPrompt(result.prompt.promptId)).prompt.status,
        ).toBe("succeeded");
        const view = await client.getSessionView?.({ sessionId });
        expect(view?.prompts.map((p) => p.promptId)).toEqual([
          result.prompt.promptId,
        ]);
        expect(view?.runs.map((r) => r.id)).not.toContain(active.runId);
        expect((await ledger.get(active.runId))?.status).toBe("interrupted");
        for (const draft of drafts)
          expect(
            getDatabase()
              .prepare(
                "SELECT status,rewound_at IS NOT NULL AS hidden FROM prompt_submission WHERE prompt_id=?",
              )
              .get(draft.promptId),
          ).toMatchObject({
            status: "cancelled",
            hidden: 1,
          });
        if (driver === "goal")
          expect(view?.goal).toMatchObject({
            status: "ready",
            value: { status: "paused" },
          });
      } finally {
        releaseChild.resolve(undefined);
        release.resolve(undefined);
      }
    },
  );

  it("times out after ten seconds without marking history, then admits a retry when the stopped run settles", async () => {
    const finalizing = createDeferred<undefined>();
    const release = createDeferred<undefined>();
    client = open({
      async execute(point) {
        if (point === "post-run") {
          finalizing.resolve(undefined);
          await release.promise;
        }
      },
    });
    const { promptId, sessionId } =
      await client.submitPromptAccepted("held run");
    try {
      await finalizing.promise;
      const started = performance.now();
      await expect(
        client.rewindSession({ sessionId, promptId, text: "not sent" }),
      ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(9_900);
      for (const table of ["message", "prompt_submission"]) {
        expect(
          getDatabase()
            .prepare(
              `SELECT 1 FROM ${table} WHERE session_id=? AND rewound_at IS NOT NULL`,
            )
            .all(sessionId),
        ).toHaveLength(0);
      }
      expect(
        getDatabase()
          .prepare("SELECT text FROM prompt_submission WHERE session_id=?")
          .all(sessionId),
      ).toEqual([{ text: "held run" }]);
    } finally {
      release.resolve(undefined);
    }
    await client.waitForPrompt(promptId);
    const retry = await client.rewindSession({
      sessionId,
      promptId,
      text: "retry",
    });
    if (!retry.prompt) throw new Error("Expected replacement after timeout");
    expect(
      (await client.waitForPrompt(retry.prompt.promptId)).prompt.status,
    ).toBe("succeeded");
  }, 20_000);

  it("commits a rewind when replacement admission fails and keeps its gate reusable", async () => {
    client = open();
    if (!client.getSessionView || !client.getSessionHistory)
      throw new Error("Expected persistent session recovery support");
    const { prompt: target } = await client.submitPromptAndWait(
      "rewind but fail to replace",
    );
    const { sessionId, promptId } = target;
    const db = getDatabase();
    db.exec(
      "CREATE TEMP TRIGGER fail_replacement BEFORE INSERT ON prompt_submission WHEN NEW.text='cannot send' BEGIN SELECT RAISE(ABORT,'forced admission error'); END",
    );
    const result = await client.rewindSession({
      sessionId,
      promptId,
      text: "cannot send",
    });
    expect(result.prompt).toBeUndefined();
    expect(result.sendError?.message).toContain("forced admission error");
    expect(result.sendError?.code).toEqual(expect.any(String));
    expect((await client.getSessionView({ sessionId })).prompts).toEqual([]);
    await expect(
      client.rewindSession({ sessionId, promptId }),
    ).rejects.toMatchObject({ code: "REWIND_TARGET_INVALID" });
    expect(
      (await client.submitPromptAndWait("next prompt", { sessionId })).prompt
        .status,
    ).toBe("succeeded");
  });
});
