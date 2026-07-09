import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEvent, UiRun } from "ohbaby-sdk";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../services/interface-providers/index.js";
import type { LLMClientInstance } from "../core/llm-client/index.js";
import {
  closeDatabase,
  getDatabase,
  schema,
} from "../services/database/index.js";
import { createDatabaseRunLedger } from "../runtime/run-ledger/index.js";
import type { HookExecutor } from "../runtime/run-manager/index.js";
import type { SnapshotService } from "../snapshot/index.js";
import { createTemporarySessionTitle } from "../services/session/index.js";
import { createPersistentUiBackendClient } from "./ui-persistent.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

const TITLE_GENERATION_PROMPT_MARKER =
  "Generate a concise title for a coding-agent chat session.";

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
      streamChatCompletion(
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
      streamChatCompletion(
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
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createProviderSubagentRunEvent(input: {
  readonly callId: string;
  readonly mode?: "foreground" | "background";
  readonly prompt: string;
  readonly subagentId?: string;
}): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify({
          description: "Persistent child",
          mode: input.mode,
          prompt: input.prompt,
          role: "explore",
          subagent_id: input.subagentId,
        }),
        id: input.callId,
        index: 0,
        name: "subagent_run",
      },
    ],
  };
}

function createProviderSubagentControlEvent(input: {
  readonly arguments: Record<string, unknown>;
  readonly callId: string;
  readonly name: "subagent_run" | "subagent_status";
}): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify(input.arguments),
        id: input.callId,
        index: 0,
        name: input.name,
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
  return persistentContentToText(request.messages.at(-1)?.content);
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
      streamChatCompletion(
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
                name: "subagent_run",
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
      streamChatCompletion(
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
  const marker = "First user message:\n";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) {
    return "Fake session title";
  }
  return createTemporarySessionTitle(
    content.slice(markerIndex + marker.length),
  );
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

      await client.submitPrompt("Remember this");
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
        message_count: 2,
      });
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
      expect(snapshot.sessions[0].messages[0].parts).toEqual([
        { type: "text", text: "Remember this" },
      ]);
      expect(snapshot.sessions[0].messages[1].parts).toEqual([
        { type: "text", text: "Persisted" },
      ]);
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0].status).toEqual({ kind: "idle" });
    } finally {
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

      await client.submitPrompt("First session");
      const firstSessionId = (await client.getSnapshot()).activeSessionId;
      await client.submitPrompt("Second session");
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
        sessionId: sessionId ?? undefined,
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

      await otherClient.submitPrompt("Other project session");
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

      await clientA.submitPrompt("Prompt for project A");
      await clientB.submitPrompt("Prompt for project B");

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

      await client.submitPrompt("First session");
      const firstSessionId = (await client.getSnapshot()).activeSessionId;
      await client.submitPrompt("Second session");
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

      await currentClient.submitPrompt("Current project session");
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

      await otherClient.submitPrompt("Other project session");
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

      await client.submitPrompt("Primary session");
      const primarySessionId = (await client.getSnapshot()).activeSessionId;
      if (!primarySessionId) {
        throw new Error("expected primary session");
      }
      const now = Date.now() + 1_000;
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.session.tableName}
           (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, last_message_at, data)
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
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        resumeSessionId: "missing",
        workdir,
      });

      await expect(restored.getSnapshot()).rejects.toThrow(
        "Session not found: missing",
      );
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists foreground subagent child sessions, transcripts, and run ledger entries", async () => {
    const directory = await tempDir("ohbaby-persistent-subagent-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const requests: InterfaceProviderRequest[] = [];
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient(
          [
            [
              createProviderSubagentRunEvent({
                callId: "call_subagent_run",
                prompt: "Inspect persistent child files",
              }),
            ],
            [{ textDelta: "child transcript persisted", finishReason: "stop" }],
            [{ textDelta: "parent got child result", finishReason: "stop" }],
          ],
          requests,
        ),
        workdir,
      });

      await client.submitPrompt("Delegate persistent child work");
      const parentSessionId = (await client.getSnapshot()).activeSessionId;
      if (!parentSessionId) {
        throw new Error("expected parent session");
      }

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
      expect(childRows).toHaveLength(1);
      const childId = childRows[0].id;
      expect(childRows[0]).toMatchObject({
        agent: "explore",
        parent_id: parentSessionId,
      });
      expect(JSON.parse(childRows[0].data)).toMatchObject({
        isSubagent: true,
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

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      const restoredSnapshot = await restored.getSnapshot();
      expect(
        restoredSnapshot.sessions.some((session) => session.id === childId),
      ).toBe(false);
      await expect(
        restored.submitPrompt("Should not run as primary", {
          sessionId: childId,
        }),
      ).rejects.toThrow("Cannot submit a primary prompt to subagent session");

      const childMessages = getDatabase()
        .prepare<{
          readonly data: string;
          readonly role: string;
        }>(
          `SELECT role, data
           FROM ${schema.message.tableName}
           WHERE session_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(childId);
      expect(childMessages.map((message) => message.role)).toEqual([
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
      const childTranscript = JSON.stringify(childParts);
      expect(childTranscript).toContain("Inspect persistent child files");
      expect(childTranscript).toContain("child transcript persisted");
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists background subagent child sessions, transcripts, and run ledger entries", async () => {
    const directory = await tempDir("ohbaby-persistent-background-subagent-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const requests: InterfaceProviderRequest[] = [];
      const client = createPersistentUiBackendClient({
        createSubagentId: () => "subagent_persistent_1",
        dbPath,
        llmClient: createPersistentBackgroundSubagentLLMClient(requests),
        workdir,
      });

      await client.submitPrompt("Open persistent background child");
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

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });
      const restoredSnapshot = await restored.getSnapshot();
      expect(
        restoredSnapshot.sessions.some((session) => session.id === childId),
      ).toBe(false);
      await expect(
        restored.submitPrompt("Should not run as primary", {
          sessionId: childId,
        }),
      ).rejects.toThrow("Cannot submit a primary prompt to subagent session");

      const childParts = getDatabase()
        .prepare<{ readonly data: string }>(
          `SELECT data
           FROM ${schema.part.tableName}
           WHERE session_id = ?
           ORDER BY created_at ASC, order_index ASC`,
        )
        .all(childId);
      const childTranscript = JSON.stringify(childParts);
      expect(childTranscript).toContain(
        "Inspect persistent background child files",
      );
      expect(childTranscript).toContain("background child persisted");

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
      expect(parentTranscript).not.toContain("background child persisted");
    } finally {
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

      await client.submitPrompt("Seed session");
      const seededSnapshot = await client.getSnapshot();
      const sessionId = seededSnapshot.activeSessionId;
      if (!sessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const runLedger = createDatabaseRunLedger({ now: () => 42_000 });
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

  it("recovers legacy ownerless runs during startup", async () => {
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

      await client.submitPrompt("Seed session");
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

      expect(snapshot.status).toEqual({ kind: "idle" });
      expect(staleRun.status.kind).toBe("error");
      expect(
        staleRun.status.kind === "error" ? staleRun.status.message : "",
      ).toContain("interrupted");
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

      await client.submitPrompt("Seed session");
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

      await owner.submitPrompt("Seed session");
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
    let firstRun: Promise<void> | undefined;
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

      firstRun = firstBackend.submitPrompt("Keep first window running");
      await withTimeout(
        firstStarted.promise,
        1_000,
        "first backend did not start running",
      );

      await expect(
        withTimeout(
          secondBackend.submitPrompt("Run in another fresh window"),
          1_000,
          "second backend was blocked by another session's active run",
        ),
      ).resolves.toBeUndefined();

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

      await owner.submitPrompt("Seed session");
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
      const queuedPrompt = contender.submitPrompt("Run after owner", {
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

      await runLedger.markInterrupted({
        reason: "owner interrupted",
        statuses: ["running"],
      });
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

      await owner.submitPrompt("Seed session");
      const ownerSnapshot = await owner.getSnapshot();
      const ownerSessionId = ownerSnapshot.activeSessionId;
      if (!ownerSessionId) {
        throw new Error("expected seeded prompt to create an active session");
      }

      const runLedger = createDatabaseRunLedger({
        now: () => 42_000,
        ownerId: "backend_dead_owner",
        ownerPid: -1,
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
          contender.submitPrompt("Run after owner death", {
            sessionId: ownerSessionId,
          }),
          1_000,
          "dead-owner prompt was not recovered before submission",
        ),
      ).resolves.toBeUndefined();

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

      await client.submitPrompt("Run without snapshot");

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

      await client.submitPrompt("Run with snapshot");

      expect(track).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
