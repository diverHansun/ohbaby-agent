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
import type { Message, MessageStore } from "./types.js";

const cleanupPaths: string[] = [];

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
  initDatabase({ dbPath: join(directory, "agent.db") });
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
