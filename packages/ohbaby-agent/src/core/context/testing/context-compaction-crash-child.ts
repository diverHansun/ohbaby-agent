import { writeFileSync } from "node:fs";
import { createBus } from "../../../bus/index.js";
import { createContextManager } from "../index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../message/index.js";
import type { MessageIdGenerator } from "../../message/index.js";
import {
  getDatabase,
  initDatabase,
  schema,
} from "../../../services/database/index.js";
import type {
  DatabaseConnection,
  DatabaseStatement,
  SqliteValue,
  StatementRunResult,
} from "../../../services/database/index.js";

const MARKER = "context-compaction:after-first-part-update:v1\n";

function ids(prefix: string): MessageIdGenerator {
  let message = 0;
  let part = 0;
  return {
    messageId: () => `${prefix}-message-${String(++message)}`,
    partId: () => `${prefix}-part-${String(++part)}`,
  };
}

function crashAfterFirstPartUpdate(markerPath: string): DatabaseConnection {
  const db = getDatabase();
  let updates = 0;
  return {
    path: db.path,
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare<Row = Record<string, unknown>>(
      sql: string,
    ): DatabaseStatement<Row> {
      const statement = db.prepare<Row>(sql);
      return {
        all(...params: SqliteValue[]): Row[] {
          return statement.all(...params);
        },
        get(...params: SqliteValue[]): Row | undefined {
          return statement.get(...params);
        },
        run(...params: SqliteValue[]): StatementRunResult {
          const result = statement.run(...params);
          if (/^\s*UPDATE part\b/iu.test(sql)) {
            updates += 1;
            if (updates === 1) {
              writeFileSync(markerPath, MARKER, "utf8");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
          }
          return result;
        },
      };
    },
    pragma<Row = Record<string, unknown>>(name: string): Row[] {
      return db.pragma<Row>(name);
    },
    close(): void {
      throw new Error("Crash fixture must not close the shared database");
    },
  };
}

async function main(): Promise<void> {
  const [dbPath, markerPath] = process.argv.slice(2);
  initDatabase({ dbPath });
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session_1",
      "project_1",
      "/repo",
      "build",
      "Session",
      "active",
      1_000,
      1_000,
      0,
      "{}",
    );
  const seed = createMessageManager({
    bus: createBus(),
    idGenerator: ids("seed"),
    store: createDatabaseMessageStore(),
  });
  for (const [index, role] of [
    "user",
    "assistant",
    "user",
    "assistant",
  ].entries()) {
    const message = await seed.createMessage({
      agent: "build",
      role: role as "assistant" | "user",
      sessionId: "session_1",
    });
    await seed.appendPart(message.id, {
      text: `${String(index)} ${"durable history ".repeat(30)}`,
      type: "text",
    });
  }
  const messageManager = createMessageManager({
    bus: createBus(),
    idGenerator: ids("compact"),
    store: createDatabaseMessageStore({
      db: crashAfterFirstPartUpdate(markerPath),
    }),
  });
  const context = createContextManager({
    bus: createBus(),
    llmClient: {
      generateSummary: () => Promise.resolve("crash-summary"),
    },
    memory: {
      load: () => Promise.resolve({ global: "", merged: "", project: "" }),
    },
    messageManager,
    pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    systemPromptProvider: {
      build: () => Promise.resolve("stable"),
    },
    tokenCounter: {
      estimateTokens: (content) => content.length,
      getLimit: () => 20_000,
    },
  });
  await context.compact("session_1", {
    directory: "/repo",
    force: true,
    modelId: "fake-model",
    toolNames: [],
    tools: undefined,
  });
  throw new Error("Compaction unexpectedly passed the crash boundary");
}

await main();
