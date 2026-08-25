import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import type {
  DatabaseConnection,
  DatabaseStatement,
  SqliteValue,
  StatementRunResult,
} from "../../services/database/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  isContextSummaryPart,
} from "../message/index.js";
import type {
  MessageIdGenerator,
  MessageManager,
  MessageWithParts,
} from "../message/index.js";
import { createContextManager } from "./context-manager.js";
import { ContextEvent } from "./events.js";
import { serializeForLlm } from "./serializer.js";
import type { ContextLLMClient, ContextManager } from "./types.js";

const cleanupPaths: string[] = [];

function createIds(prefix: string): MessageIdGenerator {
  let message = 0;
  let part = 0;
  return {
    messageId: () => `${prefix}-message-${String(++message)}`,
    partId: () => `${prefix}-part-${String(++part)}`,
  };
}

function insertSession(sessionId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
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
}

function createManager(
  messageManager: MessageManager,
  llmClient: ContextLLMClient,
  bus = createBus(),
  compaction: {
    readonly pruneMinimumTokens?: number;
    readonly pruneProtectTokens?: number;
  } = {},
): ContextManager {
  return createContextManager({
    bus,
    llmClient,
    memory: {
      load: () => Promise.resolve({ global: "", merged: "", project: "" }),
    },
    messageManager,
    pruneMinimumTokens:
      compaction.pruneMinimumTokens ?? Number.MAX_SAFE_INTEGER,
    pruneProtectTokens: compaction.pruneProtectTokens,
    systemPromptProvider: {
      build: () => Promise.resolve("stable"),
    },
    tokenCounter: {
      estimateTokens: (content) => content.length,
      getLimit: () => 20_000,
    },
  });
}

async function appendTextHistory(
  messageManager: MessageManager,
  sessionId: string,
): Promise<void> {
  for (const [index, role] of [
    "user",
    "assistant",
    "user",
    "assistant",
  ].entries()) {
    const message = await messageManager.createMessage({
      agent: "build",
      role: role as "assistant" | "user",
      sessionId,
    });
    await messageManager.appendPart(message.id, {
      text: `${String(index)} ${"durable history ".repeat(30)}`,
      type: "text",
    });
  }
}

async function appendToolHistory(
  messageManager: MessageManager,
  sessionId: string,
): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const message = await messageManager.createMessage({
      agent: "build",
      role: "assistant",
      sessionId,
    });
    await messageManager.appendPart(message.id, {
      callId: `call-${String(index)}`,
      state: {
        input: { index },
        output: `tool-${String(index)} ${"large output ".repeat(30)}`,
        status: "completed",
      },
      tool: "read",
      type: "tool",
    });
  }
}

function compact(
  manager: ContextManager,
  sessionId: string,
): ReturnType<ContextManager["compact"]> {
  return manager.compact(sessionId, {
    directory: "/repo",
    force: true,
    modelId: "fake-model",
    toolNames: [],
    tools: undefined,
  });
}

function createFailingConnection(input: {
  readonly failAt: number;
  readonly sqlFragment: string;
}): DatabaseConnection {
  const db = getDatabase();
  let matches = 0;
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
          if (sql.includes(input.sqlFragment)) {
            matches += 1;
            if (matches === input.failAt) {
              throw new Error(
                `Injected compaction failure at ${input.sqlFragment} #${String(input.failAt)}`,
              );
            }
          }
          return statement.run(...params);
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

async function reopenHistory(
  dbPath: string,
  sessionId: string,
): Promise<MessageWithParts[]> {
  closeDatabase();
  initDatabase({ dbPath });
  return createDatabaseMessageStore().listBySession(sessionId, {
    contextScopeId: undefined,
  });
}

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("atomic context compaction", () => {
  it.each([
    {
      failAt: 1,
      label: "summary message insert",
      sqlFragment: "INSERT INTO message",
    },
    {
      failAt: 1,
      label: "summary part insert",
      sqlFragment: "INSERT INTO part",
    },
    { failAt: 2, label: "second compacted mark", sqlFragment: "UPDATE part" },
  ])("rolls back $label before reopening the real store", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-context-atomic-"));
    cleanupPaths.push(directory);
    const dbPath = join(directory, "agent.db");
    initDatabase({ dbPath });
    insertSession("session_1");
    const seedManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds("seed"),
      store: createDatabaseMessageStore(),
    });
    await appendTextHistory(seedManager, "session_1");

    const faultManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds("fault"),
      store: createDatabaseMessageStore({
        db: createFailingConnection(failure),
      }),
    });
    const contextManager = createManager(faultManager, {
      generateSummary: vi.fn().mockResolvedValue("atomic-summary"),
    });

    await expect(compact(contextManager, "session_1")).rejects.toThrow(
      /Injected compaction failure/u,
    );

    const recovered = await reopenHistory(dbPath, "session_1");
    expect(
      recovered.filter((message) => message.parts.some(isContextSummaryPart)),
    ).toHaveLength(0);
    expect(
      recovered
        .flatMap((message) => message.parts)
        .every((part) => part.time?.compacted === undefined),
    ).toBe(true);
  });

  it("keeps a committed summary when an event subscriber fails and reopens without replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-context-event-"));
    cleanupPaths.push(directory);
    const dbPath = join(directory, "agent.db");
    initDatabase({ dbPath });
    insertSession("session_1");
    const subscriberErrors: unknown[] = [];
    const bus = createBus({
      onSubscriberError: (error) => {
        subscriberErrors.push(error);
      },
    });
    const terminals: unknown[] = [];
    bus.subscribe(ContextEvent.Compressed, () => {
      throw new Error("subscriber failed after commit");
    });
    bus.subscribe(ContextEvent.CompactionFinished, (event) => {
      terminals.push(event);
    });
    const messageManager = createMessageManager({
      bus,
      idGenerator: createIds("live"),
      store: createDatabaseMessageStore(),
    });
    await appendTextHistory(messageManager, "session_1");
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("committed-summary");
    const contextManager = createManager(
      messageManager,
      { generateSummary },
      bus,
    );

    await expect(compact(contextManager, "session_1")).resolves.toMatchObject({
      status: "compacted",
    });
    expect(subscriberErrors).toHaveLength(1);
    expect(terminals).toMatchObject([{ outcome: "success" }]);

    const recovered = await reopenHistory(dbPath, "session_1");
    expect(
      recovered.filter((message) => message.parts.some(isContextSummaryPart)),
    ).toHaveLength(1);
    const replayBus = createBus();
    const replayEvents: unknown[] = [];
    replayBus.subscribe(ContextEvent.CompactionStarted, (event) => {
      replayEvents.push(event);
    });
    replayBus.subscribe(ContextEvent.CompactionFinished, (event) => {
      replayEvents.push(event);
    });
    const resumeSummary = vi.fn<ContextLLMClient["generateSummary"]>();
    const resumedManager = createManager(
      createMessageManager({
        bus: replayBus,
        idGenerator: createIds("resume"),
        store: createDatabaseMessageStore(),
      }),
      { generateSummary: resumeSummary },
      replayBus,
    );
    const assembled = await resumedManager.assemble("session_1", "/repo", {
      isSubagent: false,
      toolNames: [],
    });

    expect(JSON.stringify(serializeForLlm(assembled))).toContain(
      "committed-summary",
    );
    expect(resumeSummary).not.toHaveBeenCalled();
    expect(replayEvents).toEqual([]);
    expect(generateSummary).toHaveBeenCalledOnce();
  });

  it("rolls back every prune mark when a later mark fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-context-prune-"));
    cleanupPaths.push(directory);
    const dbPath = join(directory, "agent.db");
    initDatabase({ dbPath });
    insertSession("session_1");
    const seedManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds("prune-seed"),
      store: createDatabaseMessageStore(),
    });
    await appendToolHistory(seedManager, "session_1");
    await appendTextHistory(seedManager, "session_1");
    const faultManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds("prune-fault"),
      store: createDatabaseMessageStore({
        db: createFailingConnection({
          failAt: 2,
          sqlFragment: "UPDATE part",
        }),
      }),
    });
    const contextManager = createManager(
      faultManager,
      { generateSummary: vi.fn().mockResolvedValue("unused") },
      createBus(),
      { pruneMinimumTokens: 1, pruneProtectTokens: 0 },
    );

    await expect(compact(contextManager, "session_1")).rejects.toThrow(
      /Injected compaction failure/u,
    );

    const recovered = await reopenHistory(dbPath, "session_1");
    expect(
      recovered
        .flatMap((message) => message.parts)
        .every((part) => part.time?.compacted === undefined),
    ).toBe(true);
    expect(
      recovered.filter((message) => message.parts.some(isContextSummaryPart)),
    ).toHaveLength(0);
  });
});
