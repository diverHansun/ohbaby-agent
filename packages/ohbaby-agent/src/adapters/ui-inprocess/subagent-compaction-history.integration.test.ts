import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  UiMessage,
  UiSession,
  UiRun,
  UiPromptSubmission,
} from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import { SUMMARY_AGENT_NAME } from "../../core/context/constants.js";
import {
  DatabaseSubagentExecutionStore,
  InMemorySubagentExecutionStore,
  type SubagentExecutionRecord,
  type SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import {
  createDatabaseMessageStore,
  createInMemoryMessageStore,
  createMessageManager,
  type MessageStore,
  type MessageWithParts,
} from "../../core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import { SourceSessionProjection } from "../ui-state/source-session-projection.js";
import { createSubagentConversationHistory } from "./subagent-conversation-history.js";
import { createSubagentViewReader } from "./subagent-views.js";

interface Readers {
  readonly source: SourceSessionProjection;
  readonly web: ReturnType<typeof createSubagentConversationHistory>;
  readonly cli: ReturnType<typeof createSubagentViewReader>;
}
interface Fixture {
  readonly readers: () => Readers;
  readonly reopen: () => Promise<Readers>;
  readonly cleanup: () => Promise<void>;
  readonly add: (
    id: string,
    scope: string | undefined,
    runId: string | undefined,
    createdAt: number,
    role?: "user" | "assistant",
    text?: string,
    sessionId?: string,
  ) => Promise<void>;
  readonly accept: (
    id: string,
    scope: string,
    createdAt: number,
    startedAt?: number,
  ) => Promise<SubagentExecutionRecord>;
  readonly first: SubagentExecutionRecord;
  readonly second: SubagentExecutionRecord;
  readonly sibling: SubagentExecutionRecord;
  readonly aIds: readonly string[];
  readonly firstIds: readonly string[];
  readonly secondIds: readonly string[];
  readonly bIds: readonly string[];
  readonly stored: () => Promise<readonly MessageWithParts[]>;
}
function parentId(record: SubagentExecutionRecord): string {
  if (!record.childUserMessageId)
    throw new Error("Missing reserved parent message ID");
  return record.childUserMessageId;
}

async function fixture(
  backend: "memory" | "database",
  cancelledBetweenRuns = 0,
): Promise<Fixture> {
  let directory: string | undefined;
  let databasePath: string | undefined;
  if (backend === "database") {
    directory = await mkdtemp(join(tmpdir(), "subagent-compaction-reopen-"));
    databasePath = join(directory, "agent.db");
    initDatabase({ dbPath: databasePath });
    for (const id of ["root", "child"]) {
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "project", "/repo", "explore", id, "active", 0, 0, 0, "{}");
    }
  }
  let at = 0;
  let store: MessageStore =
    backend === "database"
      ? createDatabaseMessageStore()
      : createInMemoryMessageStore();
  let executions: SubagentExecutionStore =
    backend === "database"
      ? new DatabaseSubagentExecutionStore({ db: getDatabase() })
      : new InMemorySubagentExecutionStore();
  let messages = createMessageManager({
    bus: createBus(),
    store,
    now: () => at,
  });
  async function accept(
    id: string,
    scope: string,
    createdAt: number,
    startedAt?: number,
  ): Promise<SubagentExecutionRecord> {
    const accepted = await executions.accept({
      executionId: id,
      requestId: id,
      parentSessionId: "root",
      requesterScopeId: "primary",
      requesterRunId: "root-run",
      rootSessionId: "root",
      rootRunId: "root-run",
      subagentId: scope,
      mode: "background",
      prompt: `Parent prompt ${id}`,
      createdAt,
    });
    const bound = await executions.bindChild(
      accepted.record,
      { sessionId: "child", contextScopeId: scope },
      createdAt,
    );
    const record =
      startedAt === undefined
        ? bound
        : await executions.start(bound, `${id}-run`, startedAt);
    if (!record.childUserMessageId)
      throw new Error("Execution did not reserve a parent message ID");
    await add(
      record.childUserMessageId,
      scope,
      record.childRunId,
      createdAt,
      "user",
      record.prompt,
    );
    return record;
  }
  async function add(
    id: string,
    scope: string | undefined,
    runId: string | undefined,
    createdAt: number,
    role: "user" | "assistant" = "assistant",
    text = id,
    sessionId = "child",
  ): Promise<void> {
    at = createdAt;
    await messages.createMessage({
      id,
      sessionId,
      contextScopeId: scope,
      runId,
      role,
      agent: "explore",
    });
    await messages.appendPart(id, { type: "text", text });
  }
  async function compact(
    id: string,
    scope: string | undefined,
    retiredIds: string[],
    readIds: string[],
    startedAt: number,
    committedAt: number,
    sessionId = "child",
  ): Promise<void> {
    const history = await messages.listBySession(sessionId, {
      contextScopeId: scope,
    });
    for (const readId of readIds)
      expect(history.some((message) => message.info.id === readId)).toBe(true);
    const expectedMessages = history.filter((message) =>
      retiredIds.includes(message.info.id),
    );
    const expectedParts = expectedMessages
      .flatMap((message) => message.parts)
      .filter((part) => part.time?.compacted === undefined);
    at = committedAt;
    const committed = await messages.commitCompaction({
      sessionId,
      contextScopeId: scope,
      compactedAt: committedAt,
      expectedMessages,
      expectedParts,
      summary: {
        messageId: id,
        agent: SUMMARY_AGENT_NAME,
        text: `PRIVATE SUMMARY BODY ${id}`,
        metadata: {
          readIds,
          keptIds: history
            .filter((message) => !retiredIds.includes(message.info.id))
            .map((message) => message.info.id),
          usageBeforeTokens: 48000,
          usageAfterTokens: 18000,
          omittedPartIds: [],
        },
        modelRequests: [
          {
            requestId: `${id}-request`,
            messageId: id,
            compactionId: `${id}-compaction`,
            purpose: "context-summary",
            attempt: 1,
            startedAt,
            endedAt: committedAt,
            outcome: "success",
          },
        ],
      },
    });
    expect(committed?.summary?.message.id).toBe(id);
  }
  function readers(): Readers {
    const source = new SourceSessionProjection({
      runtimeEpoch: "reconstructed",
      messageManager: messages,
      metadata: (id): Promise<Omit<UiSession, "messages">> =>
        Promise.resolve({
          id,
          title: id,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      runs: (): Promise<readonly UiRun[]> => Promise.resolve([]),
      prompts: (): Promise<readonly UiPromptSubmission[]> =>
        Promise.resolve([]),
      publish: (): void => undefined,
    });
    return {
      source,
      web: createSubagentConversationHistory({
        executions,
        messages,
        project: (record) => source.projectComplete(record),
      }),
      cli: createSubagentViewReader({
        executions,
        source,
        rootExists: (id) => Promise.resolve(id === "root"),
      }),
    };
  }
  const first = await accept("a-first", "scope-a", 1000, 1050);
  const sibling = await accept("b-first", "scope-b", 1500, 1501);
  await add("a-old-1", "scope-a", first.childRunId, 1100);
  await compact(
    "a-summary-1",
    "scope-a",
    ["a-old-1"],
    [parentId(first), "a-old-1"],
    1280,
    1300,
  );
  await add("a-middle-1", "scope-a", first.childRunId, 1400);
  await compact(
    "a-summary-2",
    "scope-a",
    ["a-summary-1", "a-middle-1"],
    [parentId(first), "a-summary-1", "a-middle-1"],
    1950,
    2000,
  );
  await executions.finish(first, {
    status: "completed",
    completedAt: 2000,
    output: "first done",
  });
  const cancelledParentIds: string[] = [];
  for (let index = 0; index < cancelledBetweenRuns; index++) {
    const cancelled = await accept(
      `a-cancelled-${String(index)}`,
      "scope-a",
      1999,
    );
    await executions.finish(cancelled, {
      status: "cancelled",
      completedAt: 2000,
    });
    cancelledParentIds.push(parentId(cancelled));
  }
  const second = await accept("a-second", "scope-a", 1999, 2000);
  await add("a-old-2", "scope-a", second.childRunId, 2000);
  // Read IDs are request inputs, not cumulative lineage. This request reads an
  // inherited summary and ordinary history without either execution parent ID.
  await compact(
    "a-summary-3",
    "scope-a",
    ["a-summary-2", "a-old-2"],
    ["a-summary-2", "a-old-2"],
    2000,
    2000,
  );
  for (let index = 1; index <= 6; index++)
    await add(`a-late-0${String(index)}`, "scope-a", second.childRunId, 2200);
  await executions.finish(second, {
    status: "completed",
    completedAt: 2300,
    output: "second done",
  });
  await add("b-old", "scope-b", sibling.childRunId, 1550);
  await compact(
    "b-summary",
    "scope-b",
    ["b-old"],
    [parentId(sibling), "b-old"],
    1580,
    1600,
  );
  await add("b-late", "scope-b", sibling.childRunId, 1700);
  await executions.finish(sibling, {
    status: "completed",
    completedAt: 1800,
    output: "sibling done",
  });
  await add(
    "root-old",
    undefined,
    "root-run",
    1100,
    "assistant",
    "root history",
    "root",
  );
  await compact(
    "root-summary",
    undefined,
    ["root-old"],
    ["root-old"],
    1180,
    1200,
    "root",
  );
  const firstIds = [
    parentId(first),
    "a-old-1",
    "a-summary-1",
    "a-middle-1",
    "a-summary-2",
  ];
  const secondIds = [
    parentId(second),
    "a-old-2",
    "a-summary-3",
    ...Array.from({ length: 6 }, (_, index) => `a-late-0${String(index + 1)}`),
  ];
  const aIds = [...firstIds, ...cancelledParentIds, ...secondIds];
  const bIds = [parentId(sibling), "b-old", "b-summary", "b-late"];
  function reopen(): Promise<Readers> {
    if (databasePath) {
      closeDatabase();
      initDatabase({ dbPath: databasePath });
      store = createDatabaseMessageStore();
      executions = new DatabaseSubagentExecutionStore({ db: getDatabase() });
    }
    messages = createMessageManager({ bus: createBus(), store, now: () => at });
    return Promise.resolve(readers());
  }
  async function cleanup(): Promise<void> {
    if (backend === "database") closeDatabase();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return {
    readers,
    reopen,
    cleanup,
    add,
    accept,
    first,
    second,
    sibling,
    aIds,
    firstIds,
    secondIds,
    bIds,
    stored: () =>
      messages.listBySession("child", { contextScopeId: "scope-a" }),
  };
}

function assertTranscript(
  actual: readonly UiMessage[],
  expectedIds: readonly string[],
  summaryIds: readonly string[],
): void {
  const ids = actual.map((message) => message.id);
  expect(ids).toEqual(expectedIds);
  expect(new Set(ids).size).toBe(ids.length);
  expect(JSON.stringify(actual)).not.toContain("PRIVATE SUMMARY BODY");
  const markers = actual.filter((message) =>
    message.parts.some((part) => part.metadata?.kind === "context-compaction"),
  );
  expect(markers.map((message) => message.id)).toEqual(summaryIds);
  for (const marker of markers) {
    expect(marker.role).toBe("system");
    expect(marker.parts).toMatchObject([
      { type: "text", text: "Compacted (estimated): 48,000 -> 18,000 tokens" },
    ]);
  }
}

async function backwardWeb(
  reader: ReturnType<typeof createSubagentConversationHistory>,
  scope: string,
  limit = 2,
): Promise<UiMessage[]> {
  let cursor: string | undefined;
  let all: UiMessage[] = [];
  for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
    const page = await reader.read({
      rootSessionId: "root",
      subagentId: scope,
      before: cursor,
      limit,
    });
    all = [...page.messages, ...all];
    if (!page.history.hasMore) return all;
    expect(page.history.before).toBeDefined();
    expect(page.history.before).not.toBe(cursor);
    cursor = page.history.before;
  }
  throw new Error("Conversation cursor did not reach its oldest page");
}

async function backwardCli(
  reader: ReturnType<typeof createSubagentViewReader>,
  executionId: string,
): Promise<UiMessage[]> {
  let cursor: string | undefined;
  let all: UiMessage[] = [];
  for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
    const page = await reader.view({
      rootSessionId: "root",
      executionId,
      before: cursor,
      limit: 2,
    });
    all = [...page.messages, ...all];
    if (!page.history.hasMore) return all;
    expect(page.history.before).toBeDefined();
    expect(page.history.before).not.toBe(cursor);
    cursor = page.history.before;
  }
  throw new Error("Execution cursor did not reach its oldest page");
}

describe.each(["memory", "database"] as const)(
  "%s durable subagent compaction history",
  (backend) => {
    it("reconstructs all three retired and active markers through Web backward and forward pages without crossing scope", async () => {
      const f = await fixture(backend);
      try {
        const before = f.readers();
        const initial = await before.web.read({
          rootSessionId: "root",
          subagentId: "scope-a",
          limit: 2,
        });
        expect(initial.messages.map((message) => message.id)).toEqual([
          "a-late-05",
          "a-late-06",
        ]);
        expect(initial.history.hasMore).toBe(true);
        const { web } = await f.reopen();
        assertTranscript(await backwardWeb(web, "scope-a"), f.aIds, [
          "a-summary-1",
          "a-summary-2",
          "a-summary-3",
        ]);
        assertTranscript(await backwardWeb(web, "scope-b"), f.bIds, [
          "b-summary",
        ]);
        const anchor = await web.read({
          rootSessionId: "root",
          subagentId: "scope-a",
          anchorExecutionId: f.first.executionId,
          limit: 1,
        });
        expect(anchor.messages.map((message) => message.id)).toEqual([
          f.first.childUserMessageId,
        ]);
        expect(anchor.history.hasMore).toBe(false);
        const forward = [...anchor.messages];
        let cursor = anchor.history.after;
        let hasLater = anchor.history.hasLater;
        for (let index = 0; hasLater && index < 30; index++) {
          const page = await web.read({
            rootSessionId: "root",
            subagentId: "scope-a",
            after: cursor,
            limit: 2,
          });
          forward.push(...page.messages);
          hasLater = page.history.hasLater;
          if (hasLater) {
            expect(page.history.after).toBeDefined();
            expect(page.history.after).not.toBe(cursor);
          }
          cursor = page.history.after;
        }
        expect(hasLater).toBe(false);
        assertTranscript(forward, f.aIds, [
          "a-summary-1",
          "a-summary-2",
          "a-summary-3",
        ]);
        const stored = await f.stored();
        const summaries = stored.filter(
          (message) => message.info.agent === SUMMARY_AGENT_NAME,
        );
        expect(summaries.map((message) => message.info.id)).toEqual([
          "a-summary-1",
          "a-summary-2",
          "a-summary-3",
        ]);
        expect(
          summaries.every((message) => message.info.runId === undefined),
        ).toBe(true);
        expect(
          summaries
            .slice(0, 2)
            .every((message) =>
              message.parts.every((part) => part.time?.compacted === 2000),
            ),
        ).toBe(true);
        expect(summaries[2].parts[0].time?.compacted).toBeUndefined();
        expect(
          summaries.every((message) =>
            message.parts.some(
              (part) =>
                part.type === "text" &&
                part.text === `PRIVATE SUMMARY BODY ${message.info.id}`,
            ),
          ),
        ).toBe(true);
        expect(
          stored.find((message) => message.info.id === "a-old-1")?.parts[0],
        ).toMatchObject({ text: "a-old-1", time: { compacted: 1300 } });
        await f.add("a-late-07", "scope-a", f.second.childRunId, 2400);
        assertTranscript(
          await backwardWeb(web, "scope-a"),
          [...f.aIds, "a-late-07"],
          ["a-summary-1", "a-summary-2", "a-summary-3"],
        );
      } finally {
        await f.cleanup();
      }
    });

    it("reopens CLI execution pages and assigns same-millisecond summaries to exactly their own execution", async () => {
      const f = await fixture(backend);
      try {
        const { cli, source } = await f.reopen();
        const latest = await cli.view({
          rootSessionId: "root",
          executionId: f.second.executionId,
          limit: 2,
        });
        expect(latest.messages.map((message) => message.id)).toEqual([
          "a-late-05",
          "a-late-06",
        ]);
        expect(latest.history.hasMore).toBe(true);
        assertTranscript(
          await backwardCli(cli, f.first.executionId),
          f.firstIds,
          ["a-summary-1", "a-summary-2"],
        );
        assertTranscript(
          await backwardCli(cli, f.second.executionId),
          f.secondIds,
          ["a-summary-3"],
        );
        assertTranscript(
          await backwardCli(cli, f.sibling.executionId),
          f.bIds,
          ["b-summary"],
        );
        const root = await source.history("root", undefined, 2);
        assertTranscript(
          root.messages,
          ["root-old", "root-summary"],
          ["root-summary"],
        );
        expect(root.messages[0].parts).toEqual([]);
        await f.add("a-late-07", "scope-a", f.second.childRunId, 2400);
        assertTranscript(
          await backwardCli(cli, f.second.executionId),
          [...f.secondIds, "a-late-07"],
          ["a-summary-3"],
        );
      } finally {
        await f.cleanup();
      }
    });

    it("skips more than one page of cancelled unstarted executions when bounding summary ownership", async () => {
      const f = await fixture(backend, 101);
      try {
        const { cli, web } = await f.reopen();
        assertTranscript(
          await backwardCli(cli, f.first.executionId),
          f.firstIds,
          ["a-summary-1", "a-summary-2"],
        );
        assertTranscript(
          await backwardCli(cli, f.second.executionId),
          f.secondIds,
          ["a-summary-3"],
        );
        assertTranscript(await backwardWeb(web, "scope-a", 100), f.aIds, [
          "a-summary-1",
          "a-summary-2",
          "a-summary-3",
        ]);
      } finally {
        await f.cleanup();
      }
    });

    it("rejects cross-scope and cross-run cursors and leaves a missing-run execution empty", async () => {
      const f = await fixture(backend);
      try {
        const { cli, web } = await f.reopen();
        const page = await cli.view({
          rootSessionId: "root",
          executionId: f.first.executionId,
          limit: 1,
        });
        expect(page.history.before).toBeDefined();
        for (const executionId of [f.second.executionId, f.sibling.executionId])
          await expect(
            cli.view({
              rootSessionId: "root",
              executionId,
              before: page.history.before,
            }),
          ).rejects.toThrow();
        const conversation = await web.read({
          rootSessionId: "root",
          subagentId: "scope-a",
          limit: 1,
        });
        await expect(
          web.read({
            rootSessionId: "root",
            subagentId: "scope-b",
            before: conversation.history.before,
          }),
        ).rejects.toThrow();
        await expect(
          web.read({
            rootSessionId: "root",
            subagentId: "scope-a",
            anchorExecutionId: f.first.executionId,
            before: conversation.history.before,
          }),
        ).rejects.toThrow();
        const legacy = await f.accept("legacy-missing-run", "scope-a", 4000);
        expect(legacy.childRunId).toBeUndefined();
        expect(
          (
            await cli.view({
              rootSessionId: "root",
              executionId: legacy.executionId,
            })
          ).messages,
        ).toEqual([]);
        const anchored = await web.read({
          rootSessionId: "root",
          subagentId: "scope-a",
          anchorExecutionId: legacy.executionId,
        });
        expect(anchored.messages.map((message) => message.id)).toEqual([
          legacy.childUserMessageId,
        ]);
      } finally {
        await f.cleanup();
      }
    });
  },
);
