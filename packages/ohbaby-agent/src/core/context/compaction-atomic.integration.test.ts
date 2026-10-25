import { resolvePreparedRequestSettings } from "ohbaby-llm";
import { createContextSummaryClient } from "../../adapters/ui-runtime/prompt-context.js";
import type { InterfaceProviderStreamEvent } from "ohbaby-llm";
import type { LLMClientInstance } from "ohbaby-llm";
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
        (id, project_id, working_directory, agent, title, status, created_at, updated_at, message_count, data)
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
): ContextManager {
  return createContextManager({
    bus,
    llmClient,
    messageManager,
    systemPromptProvider: {
      build: () => Promise.resolve("stable"),
    },
    tokenCounter: {
      estimateTokens: (content) => content.length,
      getLimit: () => 128_000,
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
      text: `${String(index)} ${"durable history ".repeat(500)}`,
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
        output: `tool-${String(index)} ${"large output ".repeat(500)}`,
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
  it.each(["length", "content_filter"] as const)(
    "never retires tool or text history after provider %s",
    async (finishReason) => {
      const directory = await mkdtemp(join(tmpdir(), "ohbaby-summary-finish-"));
      cleanupPaths.push(directory);
      const dbPath = join(directory, "agent.db");
      initDatabase({ dbPath });
      insertSession("session_1");
      const messages = createMessageManager({
        bus: createBus(),
        idGenerator: createIds("finish"),
        store: createDatabaseMessageStore(),
      });
      await appendToolHistory(messages, "session_1");
      await appendTextHistory(messages, "session_1");
      let requests = 0;
      const client: LLMClientInstance = {
        config: {
          provider: "openai",
          model: "gpt-5.2",
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-responses",
          maxTokens: 128,
        },
        provider: {
          id: "openai",
          kind: "openai-responses",
          client: {},
          isAbortError: () => false,
          async streamResponse() {
            requests += 1;
            await Promise.resolve();
            return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              await Promise.resolve();
              yield { textDelta: "partial summary", finishReason };
            })();
          },
        },
      };
      const manager = createManager(
        messages,
        createContextSummaryClient(client),
        createBus(),
      );
      const result = await manager.compact("session_1", {
        directory: "/repo",
        force: true,
        modelId: "gpt-5.2",
        requestSettings: resolvePreparedRequestSettings(client),
        toolNames: [],
        tools: undefined,
      });
      expect(requests).toBe(1);
      expect(result.compression?.status).toBe("failed");
      const recovered = await reopenHistory(dbPath, "session_1");
      const parts = recovered.flatMap((message) => message.parts);
      expect(parts.filter(isContextSummaryPart)).toHaveLength(0);
      expect(
        parts.some(
          (part) => part.type === "tool" && part.time?.compacted !== undefined,
        ),
      ).toBe(false);
      expect(
        parts
          .filter((part) => part.type === "text")
          .every((part) => part.time?.compacted === undefined),
      ).toBe(true);
    },
  );

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
      generateSummary: vi.fn().mockResolvedValue({
        text: "atomic-summary",
        summaryMessageId: "summary",
        requests: [],
      }),
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
      .mockResolvedValue({
        text: "committed-summary",
        summaryMessageId: "summary",
        requests: [],
      });
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
    const sentRequest = JSON.stringify(
      generateSummary.mock.calls[0][0].request.messages,
    );
    const retiredPartIds = recovered
      .flatMap((message) => message.parts)
      .filter((part) => part.time?.compacted !== undefined)
      .map((part) => part.id);
    expect(retiredPartIds.length).toBeGreaterThan(0);
    for (const message of recovered)
      for (const part of message.parts)
        if (retiredPartIds.includes(part.id) && part.type === "text")
          expect(sentRequest).toContain(part.text);
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
    const visiblePartIds = assembled.history.flatMap((message) =>
      message.parts.map((part) => part.id),
    );
    for (const partId of retiredPartIds) {
      expect(visiblePartIds).not.toContain(partId);
    }
    expect(resumeSummary).not.toHaveBeenCalled();
    expect(replayEvents).toEqual([]);
    expect(generateSummary).toHaveBeenCalledOnce();
  });

  it("leaves every original part active after both summary overflow attempts fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-context-overflow-"));
    cleanupPaths.push(directory);
    const dbPath = join(directory, "agent.db");
    initDatabase({ dbPath });
    insertSession("session_1");
    const messageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds("overflow"),
      store: createDatabaseMessageStore(),
    });
    await appendTextHistory(messageManager, "session_1");
    await appendTextHistory(messageManager, "session_1");
    const original = await messageManager.listBySession("session_1");
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValueOnce(
        Object.assign(new Error("context length exceeded"), {
          code: "context_length_exceeded",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("context length exceeded"), {
          code: "context_length_exceeded",
        }),
      );
    const contextManager = createManager(messageManager, { generateSummary });

    await expect(compact(contextManager, "session_1")).resolves.toMatchObject({
      status: "failed",
      compression: { status: "failed", error: "context length exceeded" },
    });
    expect(generateSummary).toHaveBeenCalledTimes(2);

    const recovered = await reopenHistory(dbPath, "session_1");
    expect(
      recovered.filter((message) => message.parts.some(isContextSummaryPart)),
    ).toHaveLength(0);
    expect(recovered).toEqual(original);
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
      {
        generateSummary: vi.fn().mockResolvedValue({
          text: "unused",
          summaryMessageId: "summary",
          requests: [],
        }),
      },
      createBus(),
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
