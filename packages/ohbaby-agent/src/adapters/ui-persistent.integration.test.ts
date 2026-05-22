import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRun } from "ohbaby-sdk";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../services/providers/index.js";
import type { LLMClientInstance } from "../core/llm-client/index.js";
import {
  closeDatabase,
  getDatabase,
  schema,
} from "../services/database/index.js";
import { createDatabaseRunLedger } from "../runtime/run-ledger/index.js";
import type { SnapshotService } from "../snapshot/index.js";
import { createPersistentUiBackendClient } from "./ui-persistent.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function createProviderStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    ProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createFakeLLMClient(
  events: readonly ProviderStreamEvent[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        _request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createProviderTaskEvent(input: {
  readonly callId: string;
  readonly prompt: string;
}): ProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify({
          agent_name: "explore",
          description: "Persistent child",
          prompt: input.prompt,
        }),
        id: input.callId,
        index: 0,
        name: "task",
      },
    ],
  };
}

function createProviderAgentTaskEvent(input: {
  readonly arguments: Record<string, unknown>;
  readonly callId: string;
  readonly name: "agent_open" | "agent_status";
}): ProviderStreamEvent {
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

function persistentContentToText(content: unknown): string {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

function lastPersistentRequestMessageText(request: ProviderRequest): string {
  return persistentContentToText(request.messages.at(-1)?.content);
}

function isPersistentExploreSubagentRequest(request: ProviderRequest): boolean {
  return JSON.stringify(request.messages).includes(
    "focused code exploration subagent",
  );
}

function createPersistentAgentTaskLLMClient(
  requests: ProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
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
              createProviderAgentTaskEvent({
                arguments: {
                  agent_name: "explore",
                  description: "Persistent background child",
                  prompt: "Inspect persistent background child files",
                },
                callId: "call_agent_open",
                name: "agent_open",
              }),
            ]),
          );
        }
        return Promise.resolve(
          createProviderStream([
            { textDelta: "parent got background task", finishReason: "stop" },
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
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly ProviderStreamEvent[])[],
  requests: ProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
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
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function requireRun(runs: readonly UiRun[], id: string): UiRun {
  const run = runs.find((candidate) => candidate.id === id);
  if (!run) {
    throw new Error(`expected run ${id}`);
  }
  return run;
}

function markBackendLeaseDead(): void {
  getDatabase()
    .prepare(
      `UPDATE ${schema.appState.tableName}
       SET value = ?, updated_at = ?
       WHERE scope = ? AND key = ?`,
    )
    .run(
      JSON.stringify({
        ownerId: "dead_backend",
        pid: -1,
        updatedAt: 42_000,
      }),
      42_000,
      "global",
      "persistentUiBackendLease",
    );
}

function readBackendLeaseValue(): string | undefined {
  return getDatabase()
    .prepare<{ readonly value: string }>(
      `SELECT value FROM ${schema.appState.tableName}
       WHERE scope = ? AND key = ?`,
    )
    .get("global", "persistentUiBackendLease")?.value;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
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

      expect(snapshot.activeSessionId).toBe(snapshot.sessions[0]?.id);
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

  it("persists task subagent child sessions, transcripts, and run ledger entries", async () => {
    const directory = await tempDir("ohbaby-persistent-subagent-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const requests: ProviderRequest[] = [];
      const client = createPersistentUiBackendClient({
        dbPath,
        llmClient: createSequentialFakeLLMClient(
          [
            [
              createProviderTaskEvent({
                callId: "call_task",
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

  it("persists agent task child sessions, transcripts, and run ledger entries", async () => {
    const directory = await tempDir("ohbaby-persistent-agent-task-");
    try {
      const dbPath = join(directory, "agent.db");
      const workdir = join(directory, "workspace");
      const requests: ProviderRequest[] = [];
      const client = createPersistentUiBackendClient({
        createAgentTaskId: () => "agent_task_1",
        dbPath,
        llmClient: createPersistentAgentTaskLLMClient(requests),
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
      expect(parentTranscript).toContain("agent_task_1");
      expect(parentTranscript).not.toContain("background child persisted");
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("marks stale pending and running runs interrupted before restoring the first snapshot", async () => {
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
      markBackendLeaseDead();

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

      const runLedger = createDatabaseRunLedger({ now: () => 42_000 });
      await runLedger.createPending({
        runId: "run_live_pending",
        sessionId,
        triggerSource: "user",
      });
      await runLedger.markRunning("run_live_pending");

      const restored = createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
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

  it("does not steal a live backend lease while the owner is idle", async () => {
    const directory = await tempDir("ohbaby-persistent-live-lease-");
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
      const firstLease = readBackendLeaseValue();
      expect(firstLease).toBeDefined();

      createPersistentUiBackendClient({
        dbPath,
        llmClient: createFakeLLMClient([]),
        workdir,
      });

      expect(readBackendLeaseValue()).toBe(firstLease);
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
});
