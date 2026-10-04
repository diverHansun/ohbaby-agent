import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";
import { createInMemoryUiStateStore } from "../../adapters/ui-state/memory-store.js";
import { startRunStreamProjection } from "../../adapters/ui-runtime/run-stream-adapter.js";
import { serializeHistory } from "../context/serialization.js";
import { estimateHistoryForCompaction } from "../context/compaction-policy.js";
import { toModelMessages } from "./converter.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
  type DatabaseConnection,
  type DatabaseStatement,
  type SqliteValue,
  type StatementRunResult,
} from "../../services/database/index.js";
import { createDatabaseMessageStore } from "./database-store.js";
import { messageToUiMessage } from "../../adapters/ui-state/persistent-store.js";
import { messageCursor } from "./pagination.js";
import { serializeHistoryMessages } from "../context/serializer.js";
import {
  createTokenUsageMetadata,
  readTokenUsageMetadata,
} from "./token-usage-metadata.js";
import type { Message, MessageStore } from "./types.js";

const cleanupPaths: string[] = [];
let databasePath = "";

function userMessage(id = "message_1"): Message {
  return {
    id,
    sessionId: "session_1",
    role: "user",
    agent: "default",
    time: { created: 1_000 },
  };
}

function insertSession(): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session_1",
      "project_1",
      "D:/repo",
      "default",
      "Session",
      "active",
      1_000,
      1_000,
      0,
      "{}",
    );
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-message-db-"));
  cleanupPaths.push(directory);
  databasePath = join(directory, "agent.db");
  initDatabase({ dbPath: databasePath });
  insertSession();
});

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("createDatabaseMessageStore", () => {
  it("keeps whitelisted details and failed partial output identical in live, snapshot and paged history", async () => {
    const message: Message = {
      id: "facts",
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      time: { created: 1000 },
    };
    const store = createDatabaseMessageStore();
    await store.insertMessage(message);
    const stateStore = createInMemoryUiStateStore({
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      sessions: [
        {
          id: "session_1",
          createdAt: "2026",
          updatedAt: "2026",
          title: "Session",
          messages: [],
        },
      ],
      status: { kind: "idle" },
    });
    const bridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
    const projection = startRunStreamProjection({
      assistantMessageId: "facts",
      autoStart: false,
      nextMessageId: () => "next",
      publish: () => undefined,
      runId: "run",
      sessionId: "session_1",
      stateStore,
      streamBridge: bridge,
      timestamp: () => "2026",
    });
    const fixtures = [
      {
        name: "bash",
        output: "partial stdout",
        error: "exit code 9",
        metadata: {
          uiToolSource: "builtin",
          exitCode: 9,
          status: "failed",
          truncated: true,
          jobId: "job",
          secret: "hidden",
        },
      },
      {
        name: "read",
        output: "1: text",
        metadata: {
          uiToolSource: "builtin",
          startLine: 1,
          shownLineCount: 1,
          hasMore: false,
        },
      },
      {
        name: "grep",
        output: "a:1: foo foo",
        metadata: {
          uiToolSource: "builtin",
          matchCount: 2,
          scanComplete: true,
          displayLimited: false,
        },
      },
      {
        name: "glob",
        output: "No files matched.",
        metadata: {
          uiToolSource: "builtin",
          count: 0,
          scanComplete: true,
          displayLimited: false,
        },
      },
      {
        name: "write",
        output: "Wrote",
        metadata: {
          uiToolSource: "builtin",
          diff: "--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new",
          diffOmitted: false,
          created: false,
        },
      },
      { name: "bash", error: "legacy failure", metadata: {} },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const callId = `call_${String(index)}`;
      const input = { command: "fixture" };
      await store.appendPart({
        message,
        partId: `part_${String(index)}`,
        updatedAt: 2000 + index,
        data: {
          type: "tool",
          callId,
          tool: fixture.name,
          state: fixture.error
            ? {
                status: "error",
                input,
                error: fixture.error,
                output: fixture.output,
                metadata: fixture.metadata,
              }
            : {
                status: "completed",
                input,
                output: fixture.output ?? "",
                metadata: fixture.metadata,
              },
        },
      });
      bridge.publish("run/run", "run.tool.start", {
        callId,
        params: input,
        runId: "run",
        sessionId: "session_1",
        timestamp: index * 2,
        toolName: fixture.name,
      });
      bridge.publish("run/run", "run.tool.result", {
        callId,
        result: {
          status: fixture.error ? "error" : "success",
          ...(fixture.output === undefined ? {} : { output: fixture.output }),
          ...(fixture.error ? { error: { message: fixture.error } } : {}),
          metadata: fixture.metadata,
        },
        runId: "run",
        sessionId: "session_1",
        timestamp: index * 2 + 1,
      });
    }
    bridge.end("run/run");
    projection.start();
    await projection.done;
    const live = (
      await stateStore.readSnapshot()
    ).sessions[0]?.messages[0]?.parts
      .filter((part) => part.type === "tool-result")
      .map((part) => part.result);
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopened = createDatabaseMessageStore();
    const history = (
      await reopened.listPageBySession("session_1", { limit: 1 })
    ).messages;
    const saved = messageToUiMessage(history[0])
      ?.parts.filter((part) => part.type === "tool-result")
      .map((part) => part.result);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(
      JSON.parse(JSON.stringify(live)),
    );
    expect(saved?.[0]).toMatchObject({
      output: "partial stdout",
      outputAvailable: true,
      error: "exit code 9",
      details: { kind: "bash", exitCode: 9, outputTruncated: true },
    });
    expect(saved?.[5]).toMatchObject({
      output: "",
      outputAvailable: false,
      error: "legacy failure",
    });
    expect(saved?.[5]?.details).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("hidden");
  });

  it("preserves tool execution facts through SQLite reopen and paged UI projection", async () => {
    const message: Message = {
      id: "tool-facts",
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      runId: "run",
      time: { created: 1_000 },
    };
    const execution = {
      phase: "ended" as const,
      createdAt: 1_100,
      phaseStartedAt: 4_100,
      executionStartedAt: 2_100,
      endedAt: 4_100,
      outcome: "timed-out" as const,
      cleanup: "confirmed" as const,
    };
    const store = createDatabaseMessageStore();
    await store.insertMessage(message);
    await store.appendPart({
      message,
      partId: "tool-part",
      data: {
        type: "tool",
        callId: "call",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "sleep 10" },
          error: "timed out",
        },
        metadata: { execution },
      },
      updatedAt: 4_100,
    });

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopened = createDatabaseMessageStore();
    const page = await reopened.listPageByRun("session_1", "run", { limit: 1 });
    expect(page.messages).toHaveLength(1);
    const saved = page.messages[0];
    expect(saved.parts[0]?.metadata?.execution).toEqual(execution);
    const ui = messageToUiMessage(saved);
    expect(ui?.parts).toMatchObject([
      { type: "tool-call", call: { execution } },
      { type: "tool-result", result: { execution, error: "timed out" } },
    ]);
    expect(page.hasMore).toBe(false);
    expect(
      messageToUiMessage({
        info: message,
        parts: [
          {
            ...saved.parts[0],
            metadata: {
              execution: { phase: "bad", createdAt: 1, phaseStartedAt: 2 },
            },
          } as unknown as (typeof saved.parts)[number],
        ],
      })?.parts,
    ).toMatchObject([
      { type: "tool-call", call: { execution: undefined } },
      {
        type: "tool-result",
        result: { execution: undefined, error: "timed out" },
      },
    ]);
  });
  it("pages forward across equal timestamps and enforces session, scope and run cursor binding", async () => {
    const store = createDatabaseMessageStore();
    for (const id of ["a", "b", "c", "d", "e"])
      await store.insertMessage({
        ...userMessage(id),
        runId: "run_a",
        contextScopeId: "scope_a",
      });
    await store.insertMessage({
      ...userMessage("foreign_run"),
      runId: "run_b",
      contextScopeId: "scope_a",
    });
    await store.insertMessage({
      ...userMessage("foreign_scope"),
      runId: "run_a",
      contextScopeId: "scope_b",
    });
    const scope = { contextScopeId: "scope_a" };
    const after = messageCursor(
      "session_1",
      { ...userMessage("a"), runId: "run_a" },
      { scope },
      "run_a",
    );
    const first = await store.listPageByRun("session_1", "run_a", {
      scope,
      after,
      limit: 2,
    });
    expect(first.messages.map(({ info }) => info.id)).toEqual(["b", "c"]);
    expect(first.hasMore).toBe(true);
    const backward = await store.listPageByRun("session_1", "run_a", {
      scope,
      before: first.nextCursor,
      limit: 2,
    });
    expect(backward.messages.map(({ info }) => info.id)).toEqual(["a", "b"]);
    expect(backward.hasMore).toBe(false);
    const second = await store.listPageByRun("session_1", "run_a", {
      scope,
      after: first.nextCursor,
      limit: 2,
    });
    expect(second.messages.map(({ info }) => info.id)).toEqual(["d", "e"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      store.listPageByRun("session_1", "run_a", {
        scope,
        after,
        before: after,
      }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_a", { scope, after: "invalid" }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_b", { scope, after }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_a", {
        scope: { contextScopeId: "scope_b" },
        after,
      }),
    ).rejects.toThrow(/cursor/i);
    const plan = getDatabase()
      .prepare<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM message WHERE session_id = ? AND json_extract(data, '$.runId') = ? AND (created_at, id) > (?, ?) ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .all("session_1", "run_a", 1000, "a", 3)
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_message_session_run_page");
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
  it("merges request observations into current JSON and keeps terminal records across reopen", async () => {
    let store = createDatabaseMessageStore();
    await store.insertMessage({
      id: "assistant",
      role: "assistant",
      agent: "default",
      sessionId: "session_1",
      runId: "run",
      time: { created: 100 },
    });
    const request = {
      requestId: "r",
      runId: "run",
      messageId: "assistant",
      step: 1,
      attempt: 1,
      purpose: "agent-step",
      startedAt: 100,
      outcome: "running" as const,
    };
    await store.updateMessage("assistant", { modelRequests: [request] });
    await store.updateMessage("assistant", {
      finish: "stop",
      time: { created: 100, completed: 500 },
    });
    await store.updateMessage("assistant", {
      modelRequests: [{ ...request, endedAt: 450, outcome: "success" }],
    });
    await store.updateMessage("assistant", {
      modelRequests: [{ ...request, firstTextAt: 999 }],
    });
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    store = createDatabaseMessageStore();
    expect(await store.getMessage("assistant")).toMatchObject({
      finish: "stop",
      time: { completed: 500 },
      modelRequests: [{ ...request, endedAt: 450, outcome: "success" }],
    });
    await expect(
      store.updateMessage("assistant", {
        modelRequests: [{ ...request, requestId: "foreign", runId: "child" }],
      }),
    ).rejects.toThrow("owner");
  });
  it("uses covering order indexes for session, scope and run keyset pages", () => {
    const queries = [
      {
        where: "session_id = ?",
        params: ["session_1"],
        index: "idx_message_session_page",
      },
      {
        where: "session_id = ? AND context_scope_id IS NULL",
        params: ["session_1"],
        index: "idx_message_session_scope_page",
      },
      {
        where: "session_id = ? AND json_extract(data, '$.runId') = ?",
        params: ["session_1", "run_a"],
        index: "idx_message_session_run_page",
      },
    ];
    for (const query of queries) {
      const plan = getDatabase()
        .prepare<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT * FROM message WHERE ${query.where} AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...query.params, 1000, "message_100", 51)
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain(query.index);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it("pages equal timestamps without duplicates and limits SQL before loading parts", async () => {
    const queries: string[] = [];
    const db = getDatabase();
    const instrumented: DatabaseConnection = {
      path: db.path,
      exec: (sql) => {
        db.exec(sql);
      },
      close: () => {
        throw new Error("Wrapper must not close DB");
      },
      pragma: (name) => db.pragma(name),
      prepare: (sql) => {
        queries.push(sql);
        return db.prepare(sql);
      },
    };
    const store = createDatabaseMessageStore({ db: instrumented });
    for (let i = 0; i < 205; i++) {
      await store.insertMessage({
        ...userMessage(`message_${String(i).padStart(3, "0")}`),
        runId: i < 3 ? "run_a" : "run_b",
      });
    }
    queries.length = 0;
    const first = await store.listPageBySession("session_1");
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0]?.info.id).toBe("message_155");
    expect(first.hasMore).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes("ORDER BY created_at DESC, id DESC LIMIT"),
      ),
    ).toBe(true);
    expect(queries.filter((sql) => sql.includes("FROM part"))).toHaveLength(1);
    const second = await store.listPageBySession("session_1", {
      before: first.nextCursor,
      limit: 200,
    });
    expect(second.messages).toHaveLength(155);
    expect(second.messages.at(-1)?.info.id).toBe("message_154");
    expect(second.hasMore).toBe(false);
    await expect(
      store.listPageBySession("session_1", { limit: 201 }),
    ).rejects.toThrow(/limit/i);
    await expect(
      store.listPageBySession("session_1", { before: "invalid" }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageBySession("other", { before: first.nextCursor }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_a"),
    ).resolves.toMatchObject({
      messages: [
        { info: { id: "message_000", runId: "run_a" } },
        { info: { id: "message_001" } },
        { info: { id: "message_002" } },
      ],
      hasMore: false,
    });
    await expect(
      store.listByIds("session_1", ["message_003", "message_002", "absent"]),
    ).resolves.toMatchObject([
      { info: { id: "message_002" } },
      { info: { id: "message_003" } },
    ]);
    await expect(store.listByIds("other", ["message_003"])).resolves.toEqual(
      [],
    );
  });

  it("idempotently saves display reasoning and preserves its own ending after reopen", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage({
      ...userMessage(),
      role: "assistant",
      agent: "default",
      finish: "error",
    });
    const input = {
      messageId: "message_1",
      partId: "real_reasoning",
      text: "thought",
      endReason: "normal" as const,
      updatedAt: 2000,
      metadata: { provider: "kept" },
    };
    await store.saveReasoningPart(input);
    await store.saveReasoningPart({ ...input, text: "thought complete" });
    await expect(
      store.saveReasoningPart({ ...input, partId: "empty", text: "" }),
    ).resolves.toBeUndefined();
    await store.insertMessage(userMessage("other"));
    await expect(
      store.saveReasoningPart({ ...input, messageId: "other" }),
    ).rejects.toThrow(/belong|identity/i);
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const history = await createDatabaseMessageStore().listByIds("session_1", [
      "message_1",
    ]);
    expect(history).toMatchObject([
      {
        info: { finish: "error" },
        parts: [
          {
            id: "real_reasoning",
            text: "thought complete",
            endReason: "normal",
            metadata: { provider: "kept" },
          },
        ],
      },
    ]);
    expect(history[0]?.parts).toHaveLength(1);
    expect(serializeHistoryMessages(history)).toEqual([]);
  });

  it("keeps model requests, summary text and token estimates unchanged by saved display reasoning", async () => {
    const store = createDatabaseMessageStore();
    const message: Message = {
      id: "assistant",
      sessionId: "session_1",
      agent: "default",
      role: "assistant",
      time: { created: 1000 },
    };
    await store.insertMessage(message);
    await store.appendPart({
      message,
      partId: "body",
      data: { type: "text", text: "Answer" },
      updatedAt: 1001,
    });
    await store.appendPart({
      message,
      partId: "tool",
      data: {
        type: "tool",
        callId: "real-call",
        tool: "read",
        state: {
          status: "completed",
          input: { path: "a" },
          output: "file contents",
        },
      },
      updatedAt: 1002,
    });
    const before = await store.listBySession("session_1");
    const protocolReasoning = new Map([
      ["assistant", "active protocol reasoning"],
    ]);
    const beforeRequest = serializeHistoryMessages(before, protocolReasoning);
    const beforeSummary = serializeHistory(before, {
      includeToolContext: true,
    });
    const beforeTokens = estimateHistoryForCompaction(before, {
      estimateTokens: (text) => text.length,
    });
    await store.saveReasoningPart({
      messageId: "assistant",
      partId: "display",
      text: "Private display text".repeat(1000),
      endReason: "normal",
      updatedAt: 1003,
    });
    const after = await store.listBySession("session_1");
    expect(serializeHistoryMessages(after, protocolReasoning)).toEqual(
      beforeRequest,
    );
    expect(beforeRequest[0]).toMatchObject({
      reasoningText: "active protocol reasoning",
    });
    expect(toModelMessages(after)).toEqual(toModelMessages(before));
    expect(serializeHistory(after, { includeToolContext: true })).toEqual(
      beforeSummary,
    );
    expect(
      estimateHistoryForCompaction(after, {
        estimateTokens: (text) => text.length,
      }),
    ).toBe(beforeTokens);
    expect(after[0]?.parts).toHaveLength(3);
  });

  it("persists messages and ordered parts", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage());

    const firstPart = await store.appendPart({
      message: userMessage(),
      partId: "part_1",
      data: { type: "text", text: "Hello" },
      updatedAt: 2_000,
    });
    const secondPart = await store.appendPart({
      message: userMessage(),
      partId: "part_2",
      data: { type: "reasoning", text: "thinking" },
      updatedAt: 3_000,
    });
    const updated = await store.updatePart(
      firstPart.id,
      { text: "Hello world" },
      4_000,
    );

    expect(secondPart.orderIndex).toBe(1);
    expect(updated).toMatchObject({ id: "part_1", text: "Hello world" });
    await expect(store.listBySession("session_1")).resolves.toMatchObject([
      {
        info: { id: "message_1", time: { updated: 4_000 } },
        parts: [
          { id: "part_1", orderIndex: 0, text: "Hello world" },
          { id: "part_2", orderIndex: 1, text: "thinking" },
        ],
      },
    ]);
  });

  it("returns stale atomically when an expected compaction part changed", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage());
    const expectedPart = await store.appendPart({
      message: userMessage(),
      partId: "part_1",
      data: { type: "text", text: "before" },
      updatedAt: 2_000,
    });
    await store.updatePart(expectedPart.id, { text: "after" }, 3_000);

    await expect(
      store.commitCompaction({
        compactedAt: 4_000,
        expectedParts: [expectedPart],
        sessionId: "session_1",
        summary: {
          data: {
            metadata: { kind: "context-summary" },
            synthetic: true,
            text: "must-not-persist",
            type: "text",
          },
          message: {
            agent: "context-summary",
            id: "summary_1",
            role: "assistant",
            sessionId: "session_1",
            time: { created: 4_000 },
          },
          partId: "summary_part_1",
        },
        updatedAt: 4_000,
      }),
    ).resolves.toBeUndefined();
    await expect(store.listBySession("session_1")).resolves.toMatchObject([
      {
        info: { id: "message_1" },
        parts: [
          {
            id: "part_1",
            text: "after",
          },
        ],
      },
    ]);
    const history = await store.listBySession("session_1");
    expect(history[0]?.parts[0]?.time?.compacted).toBeUndefined();
  });

  it("distinguishes exact primary scope from an unfiltered session query", async () => {
    const store = createDatabaseMessageStore();
    const primary = userMessage("message_primary");
    const child = {
      ...userMessage("message_child"),
      contextScopeId: "scope_a",
    };
    await store.insertMessage(primary);
    await store.insertMessage(child);

    await expect(store.listBySession("session_1")).resolves.toHaveLength(2);
    await expect(
      store.listBySession("session_1", { contextScopeId: undefined }),
    ).resolves.toMatchObject([{ info: { id: primary.id } }]);
  });

  it("round-trips raw metadata inside completed tool state", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage({
      id: "message_tool",
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      time: { created: 1_000 },
    });

    await store.appendPart({
      message: {
        id: "message_tool",
        sessionId: "session_1",
        role: "assistant",
        agent: "default",
        time: { created: 1_000 },
      },
      partId: "part_tool",
      data: {
        type: "tool",
        callId: "call_read",
        tool: "read",
        state: {
          status: "completed",
          input: { file_path: "README.md" },
          output: "content",
          metadata: {
            mtimeMs: 1234567890,
            pid: 42,
          },
        },
      },
      updatedAt: 2_000,
    });

    await expect(store.listBySession("session_1")).resolves.toMatchObject([
      {
        info: { id: "message_tool" },
        parts: [
          {
            id: "part_tool",
            state: {
              metadata: {
                mtimeMs: 1234567890,
                pid: 42,
              },
            },
          },
        ],
      },
    ]);
  });

  it("reads legacy token usage metadata after reopening the database", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage({
      id: "message_legacy_usage",
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      time: { created: 1_000 },
    });
    const part = await store.appendPart({
      message: {
        id: "message_legacy_usage",
        sessionId: "session_1",
        role: "assistant",
        agent: "default",
        time: { created: 1_000 },
      },
      partId: "part_legacy_usage",
      data: { type: "text", text: "legacy response" },
      updatedAt: 2_000,
    });
    const legacyPart = {
      ...part,
      metadata: {
        tokenUsage: {
          completionTokens: 3,
          promptTokens: 10,
          totalTokens: 999,
        },
      },
    };
    getDatabase()
      .prepare(
        `UPDATE ${schema.part.tableName}
         SET data = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(legacyPart), part.id);

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopenedStore = createDatabaseMessageStore();
    const reopened = await reopenedStore.listBySession("session_1");
    const reopenedPart = reopened
      .flatMap((message) => message.parts)
      .find((candidate) => candidate.id === part.id);

    expect(readTokenUsageMetadata(reopenedPart?.metadata)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
    });
  });

  it("round-trips canonical token usage metadata through a physical reopen", async () => {
    const store = createDatabaseMessageStore();
    const message: Message = {
      id: "message_canonical_usage",
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      time: { created: 1_000 },
    };
    await store.insertMessage(message);
    await store.appendPart({
      message,
      partId: "part_canonical_usage",
      data: {
        type: "text",
        text: "canonical response",
        metadata: createTokenUsageMetadata({
          inputBreakdown: {
            cacheRead: 40,
            cacheWrite: 10,
            observed: { cacheRead: true, cacheWrite: true },
            uncached: 70,
          },
          inputTokens: 120,
          outputTokens: 7,
          totalTokens: 127,
        }),
      },
      updatedAt: 2_000,
    });

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopened =
      await createDatabaseMessageStore().listBySession("session_1");
    const usage = reopened
      .flatMap((entry) => entry.parts)
      .map((part) => readTokenUsageMetadata(part.metadata))
      .find((candidate) => candidate !== undefined);

    expect(usage).toEqual({
      inputBreakdown: {
        cacheRead: 40,
        cacheWrite: 10,
        observed: { cacheRead: true, cacheWrite: true },
        uncached: 70,
      },
      inputTokens: 120,
      outputTokens: 7,
      totalTokens: 127,
    });
  });

  it("projects raw legacy message and part JSON after a physical reopen", async () => {
    const messageJson =
      '{"id":"legacy_assistant","sessionId":"session_1","role":"assistant","agent":"default","time":{"created":1000,"completed":2000},"finish":"tool_calls"}';
    const toolJson =
      '{"id":"legacy_tool","messageId":"legacy_assistant","sessionId":"session_1","orderIndex":1,"type":"tool","callId":"legacy_call","tool":"read","state":{"status":"completed","input":{"path":"README.md","offset":0},"output":"legacy contents","metadata":{"mtimeMs":123,"internalSecret":"keep-only-in-storage"}},"metadata":{"tokenUsage":{"promptTokens":10,"completionTokens":3,"totalTokens":999}}}';
    const reasoningJson =
      '{"id":"legacy_reasoning","messageId":"legacy_assistant","sessionId":"session_1","orderIndex":0,"type":"reasoning","text":"old reasoning must not replay"}';
    getDatabase()
      .prepare(
        `INSERT INTO ${schema.message.tableName}
         (id, session_id, context_scope_id, role, agent, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy_assistant",
        "session_1",
        null,
        "assistant",
        "default",
        1000,
        2000,
        messageJson,
      );
    for (const [id, type, order, json] of [
      ["legacy_reasoning", "reasoning", 0, reasoningJson],
      ["legacy_tool", "tool", 1, toolJson],
    ] as const) {
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.part.tableName}
           (id, message_id, session_id, type, order_index, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          "legacy_assistant",
          "session_1",
          type,
          order,
          1000,
          2000,
          json,
        );
    }

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const history =
      await createDatabaseMessageStore().listBySession("session_1");
    expect(history[0]?.parts.map((part) => part.id)).toEqual([
      "legacy_reasoning",
      "legacy_tool",
    ]);
    expect(readTokenUsageMetadata(history[0]?.parts[1]?.metadata)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
    });
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "legacy_call",
            name: "read",
            argumentsJson: '{"path":"README.md","offset":0}',
          },
        ],
      },
      {
        role: "tool",
        callId: "legacy_call",
        content:
          'legacy contents\n\n<tool_metadata>\n{"mtimeMs":123}\n</tool_metadata>',
      },
    ]);
    expect(
      getDatabase()
        .prepare<{
          data: string;
        }>(`SELECT data FROM ${schema.message.tableName} WHERE id = ?`)
        .get("legacy_assistant")?.data,
    ).toBe(messageJson);
    expect(
      getDatabase()
        .prepare<{
          data: string;
        }>(`SELECT data FROM ${schema.part.tableName} WHERE id = ?`)
        .get("legacy_tool")?.data,
    ).toBe(toolJson);
    expect(
      getDatabase()
        .prepare<{
          data: string;
        }>(`SELECT data FROM ${schema.part.tableName} WHERE id = ?`)
        .get("legacy_reasoning")?.data,
    ).toBe(reasoningJson);
  });

  it("allocates distinct order indexes during concurrent appends", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage());

    const parts = await Promise.all([
      store.appendPart({
        message: userMessage(),
        partId: "part_1",
        data: { type: "text", text: "A" },
        updatedAt: 2_000,
      }),
      store.appendPart({
        message: userMessage(),
        partId: "part_2",
        data: { type: "text", text: "B" },
        updatedAt: 2_000,
      }),
    ]);

    expect(parts.map((part) => part.orderIndex).sort()).toEqual([0, 1]);
  });

  it("keeps messages with the same timestamp in insertion order", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage("message_b"));
    await store.insertMessage(userMessage("message_a"));

    await expect(store.listBySession("session_1")).resolves.toMatchObject([
      { info: { id: "message_b" } },
      { info: { id: "message_a" } },
    ]);
  });

  it("persists and filters context scope through the physical message column", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage({
      ...userMessage("message_a"),
      contextScopeId: "subagent_a",
    });
    await store.insertMessage({
      ...userMessage("message_b"),
      contextScopeId: "subagent_b",
    });

    const rows = getDatabase()
      .prepare<{
        readonly context_scope_id: string | null;
        readonly id: string;
      }>(
        `SELECT id, context_scope_id
         FROM ${schema.message.tableName}
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all();
    expect(rows).toEqual([
      { context_scope_id: "subagent_a", id: "message_a" },
      { context_scope_id: "subagent_b", id: "message_b" },
    ]);

    await expect(
      store.listBySession("session_1", { contextScopeId: "subagent_b" }),
    ).resolves.toMatchObject([{ info: { id: "message_b" } }]);
  });

  it("enforces one part order index per message at the database layer", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage());
    await store.appendPart({
      message: userMessage(),
      partId: "part_1",
      data: { type: "text", text: "A" },
      updatedAt: 2_000,
    });

    expect(() => {
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.part.tableName}
            (id, message_id, session_id, type, order_index, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "part_duplicate",
          "message_1",
          "session_1",
          "text",
          0,
          3_000,
          3_000,
          JSON.stringify({
            id: "part_duplicate",
            messageId: "message_1",
            sessionId: "session_1",
            type: "text",
            orderIndex: 0,
            text: "B",
          }),
        );
    }).toThrow();
  });

  it("deletes messages and session history", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage("message_1"));
    await store.insertMessage(userMessage("message_2"));
    await store.appendPart({
      message: userMessage("message_1"),
      partId: "part_1",
      data: { type: "text", text: "A" },
      updatedAt: 2_000,
    });

    await store.deleteMessage("message_1");
    await expect(store.getMessage("message_1")).resolves.toBeUndefined();
    await expect(store.listBySession("session_1")).resolves.toMatchObject([
      { info: { id: "message_2" }, parts: [] },
    ]);

    await store.deleteBySession("session_1");
    await expect(store.listBySession("session_1")).resolves.toEqual([]);
  });

  it("rolls back part updates when touching the parent message fails", async () => {
    const store = createDatabaseMessageStore();
    await store.insertMessage(userMessage());
    await store.appendPart({
      message: userMessage(),
      partId: "part_1",
      data: { type: "text", text: "A" },
      updatedAt: 2_000,
    });

    const failingStore = createDatabaseMessageStore({
      db: createFailingMessageTouchConnection(),
    });

    await expect(
      failingStore.updatePart("part_1", { text: "B" }, 3_000),
    ).rejects.toThrow(/touch failed/);
    await expect(store.listBySession("session_1")).resolves.toMatchObject([
      {
        info: { time: { updated: 2_000 } },
        parts: [{ id: "part_1", text: "A" }],
      },
    ]);
  });

  it("rejects writes for missing messages", async () => {
    const store: MessageStore = createDatabaseMessageStore();

    await expect(
      store.appendPart({
        message: userMessage("missing"),
        partId: "part_1",
        data: { type: "text", text: "A" },
        updatedAt: 2_000,
      }),
    ).rejects.toThrow(/Message not found/);
  });
});

function createFailingMessageTouchConnection(): DatabaseConnection {
  const db = getDatabase();
  return {
    path: db.path,
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare<Row = Record<string, unknown>>(
      sql: string,
    ): DatabaseStatement<Row> {
      const statement = db.prepare<Row>(sql);
      if (!sql.includes(`UPDATE ${schema.message.tableName}`)) {
        return statement;
      }
      return {
        get(...params: SqliteValue[]): Row | undefined {
          return statement.get(...params);
        },
        all(...params: SqliteValue[]): Row[] {
          return statement.all(...params);
        },
        run(..._params: SqliteValue[]): StatementRunResult {
          throw new Error("touch failed");
        },
      };
    },
    pragma<Row = Record<string, unknown>>(name: string): Row[] {
      return db.pragma<Row>(name);
    },
    close(): void {
      throw new Error("Test connection wrapper must not close the database");
    },
  };
}
